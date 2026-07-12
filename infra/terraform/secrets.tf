# Secrets Manager replaces .env (F4 stage 1). ECS task definitions inject
# these as environment secrets; nothing sensitive is baked into images or
# task definitions. Values marked placeholder are set out-of-band (console/CLI)
# after the first apply — Terraform state never holds third-party keys.

resource "aws_secretsmanager_secret" "database_url" {
  name       = "dental/${var.environment}/PLATFORM_DATABASE_URL"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgres://%s:%s@%s:5432/%s",
    aws_rds_cluster.main.master_username,
    random_password.db.result,
    aws_rds_cluster.main.endpoint,
    aws_rds_cluster.main.database_name
  )
}

resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name       = "dental/${var.environment}/JWT_SECRET"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt.result
}

# Placeholders — populated out-of-band, rotated without Terraform.
resource "aws_secretsmanager_secret" "third_party" {
  for_each = toset([
    "DEEPSEEK_API_KEY",
    "ANTHROPIC_API_KEY",
    "TWILIO_AUTH_TOKEN",
    "SMTP_URL",
    "EDGE_SITE_KEYS" # JSON map of siteKey -> edge API key
  ])
  name       = "dental/${var.environment}/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}
