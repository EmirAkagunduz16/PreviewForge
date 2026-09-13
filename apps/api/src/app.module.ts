import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { NotFoundController } from "./not-found.controller.js";

@Module({
  controllers: [HealthController, NotFoundController],
})
export class AppModule {}
