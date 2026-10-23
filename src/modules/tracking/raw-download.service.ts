import { Injectable } from "@nestjs/common";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";

@Injectable()
export class RawDownloadService {
  constructor(private readonly store: TenantObjectStore) {}

  signedUrl(_resultId: string): Promise<{ url: string }> {
    void this.store;
    return Promise.reject(new Error("not implemented"));
  }
}
