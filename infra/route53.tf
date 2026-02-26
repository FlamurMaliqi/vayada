locals {
  dns_records = {
    "wildcard-booking" = "*.booking.vayada.com"
    "admin-booking"    = "admin.booking.vayada.com"
    "booking-api"      = "booking-api.vayada.com"
    "pms-api"          = "pms-api.vayada.com"
    "pms"              = "pms.vayada.com"
  }
}

resource "aws_route53_record" "services" {
  for_each = local.dns_records

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = data.aws_lb.main.dns_name
    zone_id                = data.aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
