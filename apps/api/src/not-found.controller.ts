import { All, Controller, NotFoundException } from "@nestjs/common";

@Controller()
export class NotFoundController {
  @All("*path")
  rejectUnknownRoute(): never {
    throw new NotFoundException("Route not found");
  }
}
