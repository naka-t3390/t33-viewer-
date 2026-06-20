import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListQuery } from "../js/drive.js";

test("buildListQuery: 親フォルダ配下・未ゴミ箱の検索式", () => {
  assert.equal(
    buildListQuery("FOLDER123"),
    "'FOLDER123' in parents and trashed=false"
  );
});
