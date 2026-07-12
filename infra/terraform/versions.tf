# F4 stage 1 — AWS baseline for the Dental AI Platform.
# Design artifact: reviewed, not yet applied against a real account.
# Deliberately minimal: one file per concern, default VPC-per-env topology.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Backend intentionally left local until an account exists; switch to S3 +
  # DynamoDB locking as the first act of a real deployment:
  # backend "s3" { bucket = "..."; key = "dental/terraform.tfstate"; region = "..."; dynamodb_table = "..." }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "dental-ai-platform"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
