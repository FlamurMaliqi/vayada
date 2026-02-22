locals {
  services = {
    booking-backend = {
      name           = "vayada-booking-backend"
      container_port = 8001
      cpu            = 256
      memory         = 512
      health_check   = "/health"
      log_group      = "/ecs/vayada-booking-backend"
      environment = [
        { name = "DATABASE_URL", value = "postgresql://vayada_booking_user:${var.db_booking_password}@${var.rds_endpoint}:5432/vayada_booking_db" },
        { name = "AUTH_DATABASE_URL", value = "postgresql://vayada_auth_user:${var.db_auth_password}@${var.rds_endpoint}:5432/vayada_auth_db" },
        { name = "JWT_SECRET_KEY", value = var.jwt_secret_key },
        { name = "CORS_ORIGINS", value = "https://admin.booking.vayada.com,https://pms.vayada.com" },
        { name = "CORS_ORIGIN_REGEX", value = "https://.*\\.booking\\.vayada\\.com" },
        { name = "API_PORT", value = "8001" },
        { name = "ENVIRONMENT", value = "production" },
        { name = "DEBUG", value = "false" },
      ]
    }
    booking-frontend = {
      name           = "vayada-booking-frontend"
      container_port = 3002
      cpu            = 256
      memory         = 512
      health_check   = "/en"
      log_group      = "/ecs/vayada-booking-frontend"
      environment = [
        { name = "NEXT_PUBLIC_API_URL", value = "https://booking-api.vayada.com" },
        { name = "NEXT_PUBLIC_PMS_URL", value = "https://pms-api.vayada.com" },
      ]
    }
    booking-admin = {
      name           = "vayada-booking-admin"
      container_port = 3003
      cpu            = 256
      memory         = 512
      health_check   = "/"
      log_group      = "/ecs/vayada-booking-admin"
      environment = [
        { name = "NEXT_PUBLIC_API_URL", value = "https://booking-api.vayada.com" },
      ]
    }
    pms-backend = {
      name           = "vayada-pms-backend"
      container_port = 8002
      cpu            = 256
      memory         = 512
      health_check   = "/health"
      log_group      = "/ecs/vayada-pms-backend"
      environment = [
        { name = "DATABASE_URL", value = "postgresql://vayada_pms_user:${var.db_pms_password}@${var.rds_endpoint}:5432/vayada_pms_db" },
        { name = "AUTH_DATABASE_URL", value = "postgresql://vayada_auth_user:${var.db_auth_password}@${var.rds_endpoint}:5432/vayada_auth_db" },
        { name = "JWT_SECRET_KEY", value = var.jwt_secret_key },
        { name = "CORS_ORIGINS", value = "https://pms.vayada.com,https://admin.booking.vayada.com" },
        { name = "CORS_ORIGIN_REGEX", value = "https://.*\\.booking\\.vayada\\.com" },
        { name = "API_PORT", value = "8002" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET_NAME", value = "vayada-uploads-prod" },
        { name = "SMTP_HOST", value = "email-smtp.eu-west-1.amazonaws.com" },
        { name = "SMTP_PORT", value = "587" },
        { name = "SMTP_USERNAME", value = var.smtp_username },
        { name = "SMTP_PASSWORD", value = var.smtp_password },
        { name = "SMTP_FROM", value = "noreply@vayada.com" },
        { name = "ENVIRONMENT", value = "production" },
        { name = "DEBUG", value = "false" },
      ]
    }
    pms-frontend = {
      name           = "vayada-pms-frontend"
      container_port = 3004
      cpu            = 256
      memory         = 512
      health_check   = "/"
      log_group      = "/ecs/vayada-pms-frontend"
      environment = [
        { name = "NEXT_PUBLIC_AUTH_API_URL", value = "https://booking-api.vayada.com" },
        { name = "NEXT_PUBLIC_PMS_API_URL", value = "https://pms-api.vayada.com" },
      ]
    }
  }

  # Map from service key to ECR repo name
  ecr_repo_map = {
    "booking-backend"  = "vayada-booking-backend"
    "booking-frontend" = "vayada-booking-frontend"
    "booking-admin"    = "vayada-booking-admin-frontend"
    "pms-backend"      = "vayada-pms-backend"
    "pms-frontend"     = "vayada-pms-frontend"
  }
}

resource "aws_ecs_task_definition" "services" {
  for_each = local.services

  family                   = each.value.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = data.aws_iam_role.ecs_task_execution.arn
  task_role_arn            = data.aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = each.value.name
      image     = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${local.ecr_repo_map[each.key]}:latest"
      essential = true

      portMappings = [
        {
          containerPort = each.value.container_port
          hostPort      = each.value.container_port
          protocol      = "tcp"
        }
      ]

      environment = each.value.environment

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = each.value.log_group
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Service = each.value.name
  }
}

resource "aws_ecs_service" "services" {
  for_each = local.services

  name            = "${each.value.name}-service"
  cluster         = data.aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.services[each.key].arn
    container_name   = each.value.name
    container_port   = each.value.container_port
  }

  depends_on = [
    aws_lb_listener_rule.services,
  ]

  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = {
    Service = each.value.name
  }
}
