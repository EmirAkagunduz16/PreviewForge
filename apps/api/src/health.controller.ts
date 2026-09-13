import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check() {
    return {
      service: "previewforge-api",
      status: "ok",
    } as const;
  }
}
