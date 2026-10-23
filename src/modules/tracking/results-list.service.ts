import { Injectable } from "@nestjs/common";
import type { ResultListItem, ResultsListQuery } from "../../../contracts/tracking/index.js";
import type { Page } from "../../api/pagination/page.js";

@Injectable()
export class ResultsListService {
  list(_projectId: string, _query: ResultsListQuery): Promise<Page<ResultListItem>> {
    return Promise.reject(new Error("not implemented"));
  }
}
