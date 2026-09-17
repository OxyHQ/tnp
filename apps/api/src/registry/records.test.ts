import { describe, expect, test } from "bun:test";
import { findRecordConflict, relativeRecordName, type ExistingRecord } from "./records.js";

const existing: ExistingRecord[] = [
  { id: "1", type: "A", name: "@", value: "192.0.2.1" },
  { id: "2", type: "CNAME", name: "www", value: "host.example.ox" },
  { id: "3", type: "TXT", name: "@", value: "hello" },
];

describe("findRecordConflict", () => {
  test("a CNAME cannot join a name that has any record", () => {
    expect(findRecordConflict(existing, { type: "CNAME", name: "@", value: "x.example.ox" }, null)?.code).toBe(
      "cname_conflict",
    );
    expect(findRecordConflict(existing, { type: "CNAME", name: "www", value: "y.example.ox" }, null)?.code).toBe(
      "cname_conflict",
    );
  });

  test("no other type can join a name that has a CNAME", () => {
    for (const type of ["A", "AAAA", "MX", "TXT", "NS"] as const) {
      expect(findRecordConflict(existing, { type, name: "www", value: "v" }, null)?.code).toBe("cname_conflict");
    }
  });

  test("an exact duplicate is refused; the same type with another value is fine", () => {
    expect(findRecordConflict(existing, { type: "A", name: "@", value: "192.0.2.1" }, null)?.code).toBe("duplicate");
    expect(findRecordConflict(existing, { type: "A", name: "@", value: "192.0.2.2" }, null)).toBeNull();
  });

  test("a record does not conflict with its own previous version", () => {
    expect(findRecordConflict(existing, { type: "CNAME", name: "www", value: "other.example.ox" }, "2")).toBeNull();
    expect(findRecordConflict(existing, { type: "A", name: "www", value: "192.0.2.9" }, "2")).toBeNull();
  });

  test("other names are unaffected", () => {
    expect(findRecordConflict(existing, { type: "CNAME", name: "blog", value: "x.example.ox" }, null)).toBeNull();
  });
});

describe("relativeRecordName", () => {
  test("strips the domain from a fully-qualified name", () => {
    expect(relativeRecordName("www.nate.ox", "nate.ox")).toBe("www");
    expect(relativeRecordName("nate.ox", "nate.ox")).toBe("@");
    expect(relativeRecordName("a.b.nate.ox", "nate.ox")).toBe("a.b");
  });

  test("leaves relative names alone, including ones that merely end in the label", () => {
    expect(relativeRecordName("www", "nate.ox")).toBe("www");
    expect(relativeRecordName("@", "nate.ox")).toBe("@");
    expect(relativeRecordName("xnate.ox", "nate.ox")).toBe("xnate.ox");
  });
});
