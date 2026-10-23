import { Inject, Injectable } from "@nestjs/common";
import type { ReparseResponse } from "../../../contracts/tracking/index.js";
import type { DirtyEntry } from "../../lib/rollup/dirty-dates.js";

/** Writes a workspace-local date into the `rollup_dirty` set (STORY-042). Injected so the request path never builds a Valkey client of its own. */
export type DirtyMarker = (entry: DirtyEntry) => Promise<void>;
export const REPARSE_DIRTY_MARKER = Symbol("REPARSE_DIRTY_MARKER");

@Injectable()
export class ReparseService {
  constructor(@Inject(REPARSE_DIRTY_MARKER) private readonly markDirty: DirtyMarker) {}

  reparse(_resultId: string): Promise<ReparseResponse> {
    void this.markDirty;
    return Promise.reject(new Error("not implemented"));
  }
}
