# ECS Fargate: api (Nest + in-process Temporal worker), web (Next.js),
# agents (FastAPI). Images come from CI via var.app_images. Secrets are
# injected from Secrets Manager — task definitions carry ARNs, never values.

resource "aws_ecs_cluster" "main" {
  name = "dental-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_security_group" "service" {
  name_prefix = "dental-${var.environment}-svc-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App ports from the ALB"
    from_port       = 3000
    to_port         = 4100
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description = "Service-to-service (api -> agents)"
    from_port   = 8100
    to_port     = 8100
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_cloudwatch_log_group" "apps" {
  name              = "/dental/${var.environment}/apps"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.data.arn
}

# --- IAM -----------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "dental-${var.environment}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [
        aws_secretsmanager_secret.database_url.arn,
        aws_secretsmanager_secret.jwt_secret.arn
      ],
      [for s in aws_secretsmanager_secret.third_party : s.arn]
    )
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets-read"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "dental-${var.environment}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# --- Service discovery (api -> agents over private DNS) -------------------------

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "dental.${var.environment}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "agents" {
  name = "agents"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# --- Task definitions + services -------------------------------------------------

locals {
  common_secrets = [
    { name = "PLATFORM_DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn }
  ]
  log_config = {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.apps.name
      "awslogs-region"        = var.region
      "awslogs-stream-prefix" = "svc"
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "dental-${var.environment}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.app_images.api
    essential = true
    portMappings = [{ containerPort = 4100 }]
    environment = [
      { name = "API_PORT", value = "4100" },
      { name = "NODE_ENV", value = "production" },
      { name = "AGENTS_URL", value = "http://agents.dental.${var.environment}.local:8100" },
      { name = "TEMPORAL_ADDRESS", value = var.temporal_address }
    ]
    secrets = concat(local.common_secrets, [
      { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn }
    ])
    logConfiguration = local.log_config
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.service.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4100
  }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "dental-${var.environment}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "web"
    image     = var.app_images.web
    essential = true
    portMappings = [{ containerPort = 3000 }]
    environment = [{ name = "NODE_ENV", value = "production" }]
    logConfiguration = local.log_config
  }])
}

resource "aws_ecs_service" "web" {
  name            = "web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.service.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
}

resource "aws_ecs_task_definition" "agents" {
  family                   = "dental-${var.environment}-agents"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "agents"
    image     = var.app_images.agents
    essential = true
    portMappings = [{ containerPort = 8100 }]
    secrets = concat(local.common_secrets, [
      { name = "DEEPSEEK_API_KEY", valueFrom = aws_secretsmanager_secret.third_party["DEEPSEEK_API_KEY"].arn },
      { name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.third_party["ANTHROPIC_API_KEY"].arn }
    ])
    logConfiguration = local.log_config
  }])
}

resource "aws_ecs_service" "agents" {
  name            = "agents"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.agents.arn
  desired_count   = var.agents_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.service.id]
  }

  service_registries {
    registry_arn = aws_service_discovery_service.agents.arn
  }
}
