import { describe, expect, test } from "bun:test";
import { XmlRejected, decodeXmlText, parseNamecheapDate, parseXml } from "./xml.js";

describe("parseNamecheapDate", () => {
  test("MM/DD/YYYY is midnight UTC regardless of the host time zone", () => {
    expect(parseNamecheapDate("09/05/2016", "d").toISOString()).toBe("2016-09-05T00:00:00.000Z");
    expect(parseNamecheapDate("12/31/2027", "d").toISOString()).toBe("2027-12-31T00:00:00.000Z");
    // Month first, not day first: 02/01 is February.
    expect(parseNamecheapDate("02/01/2030", "d").getUTCMonth()).toBe(1);
  });

  test("the renew format with a 12-hour clock", () => {
    expect(parseNamecheapDate("4/30/2021 11:31:13 AM", "d").toISOString()).toBe("2021-04-30T11:31:13.000Z");
    expect(parseNamecheapDate("4/30/2021 11:31:13 PM", "d").toISOString()).toBe("2021-04-30T23:31:13.000Z");
    expect(parseNamecheapDate("4/30/2021 12:00:00 AM", "d").toISOString()).toBe("2021-04-30T00:00:00.000Z");
    expect(parseNamecheapDate("4/30/2021 12:05:00 PM", "d").toISOString()).toBe("2021-04-30T12:05:00.000Z");
  });

  test("rolled-over and foreign formats are rejected rather than reinterpreted", () => {
    for (const value of ["02/30/2020", "13/01/2020", "2020-01-01", "01/01/20", "4/30/2021 13:00:00 PM", "4/30/2021 11:61:00 AM", ""]) {
      expect(() => parseNamecheapDate(value, "d")).toThrow(XmlRejected);
    }
  });
});

describe("parseXml", () => {
  test("decodes predefined entities once and leaves unknown entities literal", () => {
    expect(decodeXmlText("&amp;lt; &lt; &#65;&#x42; &nbsp; &#x110000;")).toBe("&lt; < AB &nbsp; &#x110000;");
  });

  test("rejects DOCTYPE and ENTITY in any case", () => {
    for (const body of ['<!doctype x><a/>', '<?xml version="1.0"?><!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>', '<a><!ENTITY b "c"></a>']) {
      expect(() => parseXml(body)).toThrow(expect.objectContaining({ reason: "doctype" }));
    }
  });

  test("rejects unclosed and garbage documents", () => {
    for (const body of ["<ApiResponse Status=\"OK\"><CommandResponse>", "<a></b>", "not xml at all"]) {
      expect(() => parseXml(body)).toThrow(XmlRejected);
    }
  });
});
