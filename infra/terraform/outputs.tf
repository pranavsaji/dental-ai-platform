output "alb_dns_name" {
  description = "Public entry point (point the app domain's CNAME here)"
  value       = aws_lb.main.dns_name
}

output "rds_endpoint" {
  description = "Aurora writer endpoint (private subnets only)"
  value       = aws_rds_cluster.main.endpoint
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}

output "secret_arns" {
  description = "Secrets Manager ARNs the deploy pipeline may need"
  value = {
    database_url = aws_secretsmanager_secret.database_url.arn
    jwt_secret   = aws_secretsmanager_secret.jwt_secret.arn
  }
}
