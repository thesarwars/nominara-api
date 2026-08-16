import { Injectable } from "@nestjs/common";

// STORY-022 — scaffold only. Logic (calling Drizzle directly per
// coding-standards.md §3) lands with this bounded area's own future story.
@Injectable()
export class AgencyService {}
