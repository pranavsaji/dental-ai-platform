variable "region" {
  description = "AWS region (BAA-eligible regions only)"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name"
  type        = string
  default     = "staging"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones to spread across"
  type        = number
  default     = 2
}

variable "db_instance_class" {
  description = "Aurora PostgreSQL instance class"
  type        = string
  default     = "db.r6g.large"
}

variable "app_images" {
  description = "Container images per service (ECR URIs pushed by CI)"
  type = object({
    api    = string
    web    = string
    agents = string
  })
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "web_desired_count" {
  type    = number
  default = 2
}

variable "agents_desired_count" {
  type    = number
  default = 1
}

variable "domain_certificate_arn" {
  description = "ACM certificate for the ALB HTTPS listener ('' = HTTP only, pre-domain)"
  type        = string
  default     = ""
}

variable "temporal_address" {
  description = "Temporal Cloud gRPC endpoint (F4 stage 2); workers run in-process in the api service"
  type        = string
  default     = ""
}
