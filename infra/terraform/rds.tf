# Aurora PostgreSQL — the canonical store. pgvector ships with Aurora PG 15+;
# `CREATE EXTENSION vector` runs in the platform bootstrap, not here.
# Everything is KMS-encrypted with a customer-managed key (BAA posture).

resource "aws_kms_key" "data" {
  description             = "dental-${var.environment} data-at-rest key (RDS, secrets, logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/dental-${var.environment}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_db_subnet_group" "main" {
  name       = "dental-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name_prefix = "dental-${var.environment}-db-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from ECS services only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_rds_cluster" "main" {
  cluster_identifier        = "dental-${var.environment}"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  database_name             = "dental"
  master_username           = "dental"
  master_password           = random_password.db.result
  db_subnet_group_name      = aws_db_subnet_group.main.name
  vpc_security_group_ids    = [aws_security_group.db.id]
  storage_encrypted         = true
  kms_key_id                = aws_kms_key.data.arn
  backup_retention_period   = 14
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "dental-${var.environment}-final"
}

resource "aws_rds_cluster_instance" "main" {
  count              = 1
  identifier         = "dental-${var.environment}-${count.index}"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = var.db_instance_class
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version
}
