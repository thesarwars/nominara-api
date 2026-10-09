import { Module } from "@nestjs/common";
import { SupportGrantsService } from "./support-grants.service.js";
import { TrustController } from "./trust.controller.js";

// NEW-D-5 — registration only.
@Module({
  controllers: [TrustController],
  providers: [SupportGrantsService],
})
export class TrustModule {}
