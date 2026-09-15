(function installXiaoAiScheduleImporterV2() {
  "use strict";

  const GLOBAL_NAME = "__XIAOAI_SCHEDULE_IMPORTER_V2__";
  const JOURNAL_KEY = "__xiaoai_schedule_importer_journal_v2__";
  const existingImporter = window[GLOBAL_NAME];
  if (existingImporter) {
    if (typeof existingImporter.__recordInstallAttempt === "function") {
      existingImporter.__recordInstallAttempt();
    }
    console.log("XIAOAI_IMPORTER_INSTALLED_ALREADY: existing one-shot instance retained");
    return typeof existingImporter.report === "function" ? existingImporter.report() : undefined;
  }

  const EXPECTED_ORIGIN = "https://i.ai.mi.com";
  const pageEnv = typeof window.env === "string" && /^[A-Za-z0-9_-]+$/.test(window.env)
    ? window.env
    : "aiSchedule";
  const SOURCE_NAME = "course-app-" + pageEnv;
  const TIMEOUT_MS = 8000;
  const POLL_INTERVAL_MS = 350;
  const POLL_ATTEMPTS = 12;
  const STABLE_READS = 2;
  const MANUAL_UNPROVEN_CREATE_CONFIRMATION = "I_MANUALLY_REVIEWED_THE_UNKNOWN_TABLE";
  const MANUAL_ABSENT_OWNED_TABLE_CONFIRMATION = "I_MANUALLY_DELETED_THE_OWNED_TEST_TABLE_AND_ACCEPT_CURRENT_TABLE";
  const LIMITS = Object.freeze({
    maxCourses: 200,
    maxPayloadBytes: 512000,
    tableName: 40,
    courseName: 100,
    teacher: 100,
    position: 100,
    style: 7,
    maxSection: 30,
    maxWeek: 30
  });
  const ROOT_KEYS = ["version", "tableName", "courses", "schedule"];
  const COURSE_KEYS = ["name", "teacher", "position", "day", "sections", "weeks", "style"];
  const REQUIRED_COURSE_KEYS = ["name", "teacher", "position", "day", "sections", "weeks"];
  const COURSE_COLORS = [
    { color: "#00A6F2", background: "#E5F4FF" },
    { color: "#FC6B50", background: "#FDEBDE" },
    { color: "#3CB3C8", background: "#DEFBF8" },
    { color: "#7D7AEA", background: "#EDEDFF" },
    { color: "#FF9900", background: "#FCEBCD" },
    { color: "#EF5B75", background: "#FFEFF0" },
    { color: "#5B8EFF", background: "#EAF1FF" },
    { color: "#F067BB", background: "#FFEDF8" },
    { color: "#29BBAA", background: "#E2F8F3" },
    { color: "#CBA713", background: "#FFF8C8" },
    { color: "#B967E3", background: "#F9EDFF" },
    { color: "#6E8ADA", background: "#F3F2FD" }
  ];
  const createdAt = new Date().toISOString();
  const history = [];
  const detectedJournal = readJournal();
  const sessionMarker = detectedJournal && detectedJournal.sessionMarker
    ? detectedJournal.sessionMarker
    : makeSessionMarker();

  let preparedPayload = null;
  let preparedSummary = null;
  let validationErrors = [];
  let profileMaxCourses = null;
  let originalTableId = detectedJournal ? detectedJournal.originalTableId : null;
  let generatedTableId = detectedJournal ? detectedJournal.generatedTableId : null;
  let generatedSettingId = detectedJournal ? detectedJournal.generatedSettingId : null;
  let payloadHash = detectedJournal ? detectedJournal.payloadHash : null;
  let generatedOwnershipProven = !!(detectedJournal && detectedJournal.tableOwnershipProvenInMemory &&
    idPresent(detectedJournal.generatedTableId));
  let responseIds = detectedJournal ? detectedJournal.responseIds.map(String) : [];
  let baselineCourseIds = new Map();
  let baselineTableIds = new Set();
  let operationRunning = false;
  let commitStarted = false;
  let tableCreateStarted = !!(detectedJournal && detectedJournal.tableCreateStarted);
  let switchRequestStarted = !!(detectedJournal && detectedJournal.switchRequestStarted);
  let uploadRequestStarted = !!(detectedJournal && detectedJournal.uploadNetworkStarted);
  let uploadNetworkStarted = !!(detectedJournal && detectedJournal.uploadNetworkStarted);
  let uploadResponseReceived = false;
  let uploadAccepted = false;
  let uploadRequestCount = detectedJournal && detectedJournal.uploadNetworkStarted ? 1 : 0;
  let switchedToGenerated = false;
  let importVerified = !!(detectedJournal && detectedJournal.importVerified);
  let originalRestored = false;
  let generatedTableDeleted = false;
  let residueFree = false;
  let cleanupScanComplete = null;
  let destructiveRecoveryBlocked = false;
  let unresolvedFingerprintResidueCount = 0;
  let recoveryAttempts = 0;
  let persistedVerifiedJournalCleared = false;
  let manualReviewAcknowledged = false;
  let manualReviewReloadRequired = false;
  let journalState = detectedJournal;
  let journalBlocked = !!(detectedJournal && detectedJournal.unfinished);
  let journalAvailable = typeof window.localStorage !== "undefined";
  let finalStatus = journalBlocked ? "JOURNAL_INCOMPLETE" : "NOT_PREPARED";

  function add(operation, status, detail) {
    const entry = { at: new Date().toISOString(), operation, status, detail };
    history.push(entry);
    try {
      const sink = window.__XIAOAI_IMPORTER_EVENT_SINK__;
      if (typeof sink === "function") sink({ at: entry.at, operation, status });
    } catch (_) {}
    console.log("[XiaoAi schedule importer]", entry);
    return entry;
  }

  function makeSessionMarker() {
    const raw = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : String(Date.now());
    return "XI" + raw.slice(0, 12).toUpperCase();
  }

  function safeJournal(value) {
    if (!value || typeof value !== "object" || value.schemaVersion !== 2 || value.unfinished !== true) return null;
    const marker = typeof value.sessionMarker === "string" && /^XI[A-Z0-9]{8,20}$/.test(value.sessionMarker)
      ? value.sessionMarker
      : "XIUNKNOWN";
    return {
      schemaVersion: 2,
      unfinished: true,
      sessionMarker: marker,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "unknown",
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "unknown",
      stage: typeof value.stage === "string" && /^[A-Z0-9_]{1,40}$/.test(value.stage)
        ? value.stage
        : "UNKNOWN",
      contractVersion: value.contractVersion === 2 ? 2 : null,
      courseCount: Number.isInteger(value.courseCount) && value.courseCount >= 0 ? value.courseCount : 0,
      tableNameLength: Number.isInteger(value.tableNameLength) && value.tableNameLength >= 0 ? value.tableNameLength : 0,
      tableCreateStarted: value.tableCreateStarted === true,
      tableOwnershipProvenInMemory: value.tableOwnershipProvenInMemory === true,
      switchRequestStarted: value.switchRequestStarted === true,
      uploadNetworkStarted: value.uploadNetworkStarted === true,
      importVerified: value.importVerified === true,
      recoveryRequired: value.recoveryRequired === true,
      payloadHash: typeof value.payloadHash === "string" && /^[0-9a-f]{64}$/.test(value.payloadHash) ? value.payloadHash : null,
      originalTableId: idPresent(value.originalTableId) ? value.originalTableId : null,
      generatedTableId: idPresent(value.generatedTableId) ? value.generatedTableId : null,
      generatedSettingId: idPresent(value.generatedSettingId) ? value.generatedSettingId : null,
      responseIds: Array.isArray(value.responseIds) ? value.responseIds.filter(idPresent).slice(0, LIMITS.maxCourses) : []
    };
  }

  function readJournal() {
    try {
      if (!window.localStorage) return null;
      const raw = window.localStorage.getItem(JOURNAL_KEY);
      if (!raw) return null;
      return safeJournal(JSON.parse(raw)) || {
        schemaVersion: 2,
        unfinished: true,
        sessionMarker: "XIUNKNOWN",
        createdAt: "unknown",
        updatedAt: "unknown",
        stage: "INVALID_JOURNAL",
        contractVersion: null,
        courseCount: 0,
        tableNameLength: 0,
        tableCreateStarted: false,
        tableOwnershipProvenInMemory: false,
        switchRequestStarted: false,
        uploadNetworkStarted: false,
        importVerified: false,
        recoveryRequired: true
      };
    } catch (_) {
      return null;
    }
  }

  function journalSnapshot(stage, recoveryRequired) {
    return {
      schemaVersion: 2,
      unfinished: true,
      sessionMarker,
      createdAt: journalState && journalState.createdAt !== "unknown" ? journalState.createdAt : createdAt,
      updatedAt: new Date().toISOString(),
      stage,
      contractVersion: 2,
      courseCount: preparedPayload ? preparedPayload.courses.length : (journalState ? journalState.courseCount : 0),
      tableNameLength: preparedPayload ? preparedPayload.tableName.length : (journalState ? journalState.tableNameLength : 0),
      tableCreateStarted,
      tableOwnershipProvenInMemory: generatedOwnershipProven,
      switchRequestStarted,
      uploadNetworkStarted,
      importVerified,
      recoveryRequired: recoveryRequired === true,
      payloadHash,
      originalTableId,
      generatedTableId,
      generatedSettingId,
      responseIds: responseIds.slice()
    };
  }

  function writeJournal(stage, recoveryRequired) {
    const snapshot = journalSnapshot(stage, recoveryRequired);
    try {
      if (!window.localStorage) throw new Error("LOCAL_STORAGE_UNAVAILABLE");
      window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(snapshot));
      const verified = readJournal();
      if (!verified || verified.sessionMarker !== sessionMarker || verified.stage !== stage) {
        throw new Error("JOURNAL_VERIFY_FAILED");
      }
      journalState = verified;
      journalAvailable = true;
      return true;
    } catch (_) {
      journalAvailable = false;
      return false;
    }
  }

  function clearJournal() {
    try {
      if (!window.localStorage) throw new Error("LOCAL_STORAGE_UNAVAILABLE");
      window.localStorage.removeItem(JOURNAL_KEY);
      if (window.localStorage.getItem(JOURNAL_KEY) !== null) throw new Error("JOURNAL_CLEAR_FAILED");
      journalState = null;
      journalBlocked = false;
      journalAvailable = true;
      return true;
    } catch (_) {
      journalAvailable = false;
      return false;
    }
  }

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function requestId() {
    const raw = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    return raw.replace(/-/g, "").toUpperCase();
  }

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function idPresent(value) {
    return value !== null && typeof value !== "undefined" && String(value) !== "";
  }

  function tableIdOf(table) {
    if (!table) return null;
    return idPresent(table.id) ? table.id : table.ctId;
  }

  function isCurrent(table) {
    return !!table && (table.current === 1 || table.current === true);
  }

  function stableJson(value) {
    if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ":" + stableJson(value[key]);
      }).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  async function sha256Text(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function utf8ByteLength(value) {
    return new TextEncoder().encode(value).length;
  }

  function transactionExtend() {
    return JSON.stringify({
      xiaoaiImporter: { version: 2, transactionId: sessionMarker, payloadHash: payloadHash }
    });
  }

  function normalizeNumberString(value, min, max, path, errors) {
    if (!Array.isArray(value) || !value.length) {
      errors.push({ path, code: "MUST_BE_NON_EMPTY_INTEGER_ARRAY" });
      return null;
    }
    const values = value.slice();
    if (values.some(function (item) { return !Number.isInteger(item) || item < min || item > max; })) {
      errors.push({ path, code: "VALUE_OUT_OF_RANGE" });
      return null;
    }
    if (new Set(values).size !== values.length) errors.push({ path, code: "DUPLICATE_VALUE" });
    return values.sort(function (left, right) { return left - right; }).join(",");
  }

  function normalizeString(value, path, maxLength, allowEmpty, errors) {
    if (typeof value !== "string") {
      errors.push({ path, code: "MUST_BE_STRING" });
      return null;
    }
    const normalized = value.normalize("NFC").trim();
    if (!allowEmpty && !normalized) errors.push({ path, code: "MUST_NOT_BE_EMPTY" });
    if (normalized.length > maxLength) errors.push({ path, code: "TOO_LONG", limit: maxLength });
    if (/\u0000/.test(normalized)) errors.push({ path, code: "CONTAINS_NULL" });
    return normalized;
  }

  function normalizeStyle(value, path, errors) {
    if (typeof value === "undefined") return undefined;
    const text = normalizeString(value, path, LIMITS.style, false, errors);
    if (text === null || !text) return text;
    if (!/^#[0-9A-Fa-f]{6}$/.test(text)) errors.push({ path, code: "STYLE_MUST_BE_HEX_COLOR" });
    return text.toUpperCase();
  }

  function normalizeSchedule(schedule, errors) {
    const path = "schedule";
    const keys = ["totalWeek", "startSemester", "startWithSunday", "showWeekend", "forenoon", "afternoon", "night", "sections"];
    if (!isPlainObject(schedule)) {
      errors.push({ path, code: "MUST_BE_OBJECT" });
      return null;
    }
    unexpectedKeys(schedule, keys, path, errors);
    keys.forEach(function (key) { if (!own(schedule, key)) errors.push({ path: path + "." + key, code: "REQUIRED" }); });
    ["totalWeek", "forenoon", "afternoon", "night"].forEach(function (key) {
      if (!Number.isInteger(schedule[key]) || schedule[key] < (key === "totalWeek" ? 1 : 0) || schedule[key] > 30) {
        errors.push({ path: path + "." + key, code: "INTEGER_OUT_OF_RANGE" });
      }
    });
    if (typeof schedule.startWithSunday !== "boolean") errors.push({ path: path + ".startWithSunday", code: "MUST_BE_BOOLEAN" });
    if (typeof schedule.showWeekend !== "boolean") errors.push({ path: path + ".showWeekend", code: "MUST_BE_BOOLEAN" });
    if (typeof schedule.startSemester !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(schedule.startSemester)) {
      errors.push({ path: path + ".startSemester", code: "MUST_BE_ISO_DATE" });
    } else {
      const parts = schedule.startSemester.split("-").map(Number);
      const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      const expectedDay = schedule.startWithSunday === true ? 0 : 1;
      if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 ||
          date.getUTCDate() !== parts[2] || date.getUTCDay() !== expectedDay) {
        errors.push({ path: path + ".startSemester", code: "SEMESTER_START_WEEKDAY" });
      }
    }
    if (!Array.isArray(schedule.sections) || !schedule.sections.length || schedule.sections.length > 30) {
      errors.push({ path: path + ".sections", code: "INVALID_SECTION_TIMES" });
      return null;
    }
    const sectionTimes = schedule.sections.map(function (slot, index) {
      const slotPath = path + ".sections[" + index + "]";
      if (!isPlainObject(slot)) {
        errors.push({ path: slotPath, code: "MUST_BE_OBJECT" });
        return null;
      }
      unexpectedKeys(slot, ["section", "startTime", "endTime"], slotPath, errors);
      if (slot.section !== index + 1) errors.push({ path: slotPath + ".section", code: "SECTION_NOT_CONTIGUOUS" });
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.startTime || "") || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.endTime || "")) {
        errors.push({ path: slotPath, code: "INVALID_TIME" });
      }
      if (String(slot.startTime) >= String(slot.endTime)) errors.push({ path: slotPath, code: "SECTION_TIME_ORDER" });
      if (index > 0 && String(schedule.sections[index - 1].endTime) > String(slot.startTime)) {
        errors.push({ path: slotPath, code: "SECTION_TIME_OVERLAP" });
      }
      return { section: slot.section, startTime: slot.startTime, endTime: slot.endTime };
    }).filter(Boolean);
    if (schedule.forenoon + schedule.afternoon + schedule.night !== sectionTimes.length) {
      errors.push({ path, code: "SECTION_PARTITION_MISMATCH" });
    }
    return {
      totalWeek: schedule.totalWeek,
      startSemester: schedule.startSemester,
      startWithSunday: schedule.startWithSunday,
      showWeekend: schedule.showWeekend,
      forenoon: schedule.forenoon,
      afternoon: schedule.afternoon,
      night: schedule.night,
      sections: sectionTimes
    };
  }

  function unexpectedKeys(value, allowed, path, errors) {
    Object.keys(value).forEach(function (key) {
      if (allowed.indexOf(key) === -1) errors.push({ path: path ? path + "." + key : key, code: "UNEXPECTED_FIELD" });
    });
  }

  function fingerprint(course) {
    return stableJson({
      name: course.name,
      teacher: course.teacher,
      position: course.position,
      day: Number(course.day),
      sections: normalizeComparableList(course.sections),
      weeks: normalizeComparableList(course.weeks),
      style: normalizeComparableStyle(course.style)
    });
  }

  function normalizeComparableList(value) {
    const values = Array.isArray(value) ? value : String(value == null ? "" : value).split(",");
    return values.map(Number).filter(Number.isFinite).sort(function (left, right) { return left - right; }).join(",");
  }

  function normalizeComparableStyle(value) {
    if (typeof value !== "string") return "";
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? stableJson(parsed) : value;
    } catch (_) {
      return value;
    }
  }

  function matchesSpec(course, spec) {
    if (!course || !spec) return false;
    const index = preparedPayload ? preparedPayload.courses.indexOf(spec) : 0;
    const expected = courseForServer(spec, index < 0 ? 0 : index);
    return fingerprint({
      name: typeof course.name === "string" ? course.name : "",
      teacher: typeof course.teacher === "string" ? course.teacher : "",
      position: typeof course.position === "string" ? course.position : "",
      day: course.day,
      sections: course.sections,
      weeks: course.weeks,
      style: course.style
    }) === fingerprint(expected);
  }

  function courseForServer(course, index) {
    const palette = COURSE_COLORS[index % COURSE_COLORS.length];
    const style = course.style
      ? { color: course.style, background: palette.background }
      : palette;
    return {
      name: course.name,
      position: course.position,
      teacher: course.teacher,
      day: course.day,
      sections: normalizeComparableList(course.sections),
      style: JSON.stringify(style),
      weeks: normalizeComparableList(course.weeks)
    };
  }

  function normalizePayload(payload) {
    const errors = [];
    if (!isPlainObject(payload)) {
      return { errors: [{ path: "$", code: "MUST_BE_OBJECT" }], normalized: null };
    }
    unexpectedKeys(payload, ROOT_KEYS, "", errors);
    ROOT_KEYS.forEach(function (key) {
      if (!own(payload, key)) errors.push({ path: key, code: "REQUIRED" });
    });
    if (payload.version !== 2) errors.push({ path: "version", code: "UNSUPPORTED_CONTRACT_VERSION", supported: 2 });
    const tableName = normalizeString(payload.tableName, "tableName", LIMITS.tableName, false, errors);
    if (!Array.isArray(payload.courses)) {
      errors.push({ path: "courses", code: "MUST_BE_ARRAY" });
      return { errors, normalized: null };
    }
    if (!payload.courses.length) errors.push({ path: "courses", code: "MUST_NOT_BE_EMPTY" });
    if (payload.courses.length > LIMITS.maxCourses) {
      errors.push({ path: "courses", code: "TOO_MANY_ITEMS", limit: LIMITS.maxCourses });
    }
    const courses = payload.courses.slice(0, LIMITS.maxCourses).map(function (course, index) {
      const path = "courses[" + index + "]";
      if (!isPlainObject(course)) {
        errors.push({ path, code: "MUST_BE_OBJECT" });
        return null;
      }
      unexpectedKeys(course, COURSE_KEYS, path, errors);
      REQUIRED_COURSE_KEYS.forEach(function (key) {
        if (!own(course, key)) errors.push({ path: path + "." + key, code: "REQUIRED" });
      });
      const day = course.day;
      if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7) {
        errors.push({ path: path + ".day", code: "MUST_BE_INTEGER_1_TO_7" });
      }
      return {
        name: normalizeString(course.name, path + ".name", LIMITS.courseName, false, errors),
        teacher: normalizeString(course.teacher, path + ".teacher", LIMITS.teacher, true, errors),
        position: normalizeString(course.position, path + ".position", LIMITS.position, true, errors),
        day,
        sections: normalizeNumberString(course.sections, 1, LIMITS.maxSection, path + ".sections", errors),
        weeks: normalizeNumberString(course.weeks, 1, LIMITS.maxWeek, path + ".weeks", errors),
        style: normalizeStyle(course.style, path + ".style", errors)
      };
    }).filter(Boolean);
    if (!errors.length) {
      const fingerprints = courses.map(fingerprint);
      const duplicates = new Set();
      fingerprints.forEach(function (value, index) {
        if (fingerprints.indexOf(value) !== index) duplicates.add(index);
      });
      duplicates.forEach(function (index) {
        errors.push({ path: "courses[" + index + "]", code: "DUPLICATE_COURSE_FINGERPRINT" });
      });
    }
    const normalizedSchedule = normalizeSchedule(payload.schedule, errors);
    if (normalizedSchedule) {
      courses.forEach(function (course, index) {
        const weeks = String(course.weeks || "").split(",").map(Number);
        const sections = String(course.sections || "").split(",").map(Number);
        if (weeks.some(function (week) { return week > normalizedSchedule.totalWeek; })) {
          errors.push({ path: "courses[" + index + "].weeks", code: "COURSE_WEEK_EXCEEDS_TOTAL" });
        }
        if (sections.some(function (section) { return section > normalizedSchedule.sections.length; })) {
          errors.push({ path: "courses[" + index + "].sections", code: "COURSE_SECTION_EXCEEDS_SLOTS" });
        }
        if (course.day >= 6 && !normalizedSchedule.showWeekend) {
          errors.push({ path: "courses[" + index + "].day", code: "WEEKEND_COURSE_HIDDEN" });
        }
      });
    }
    const normalized = { version: 2, tableName, courses, schedule: normalizedSchedule };
    if (!errors.length && utf8ByteLength(JSON.stringify(normalized)) > LIMITS.maxPayloadBytes) {
      errors.push({ path: "$", code: "PAYLOAD_TOO_LARGE", limit: LIMITS.maxPayloadBytes });
    }
    return { errors, normalized: errors.length ? null : normalized };
  }

  function makePreparedSummary(payload) {
    const dayCounts = {};
    let sectionReferences = 0;
    let weekReferences = 0;
    payload.courses.forEach(function (course) {
      dayCounts[String(course.day)] = (dayCounts[String(course.day)] || 0) + 1;
      sectionReferences += course.sections.split(",").length;
      weekReferences += course.weeks.split(",").length;
    });
    return {
      status: "READY",
      contractVersion: payload.version,
      tableNameLength: payload.tableName.length,
      courseCount: payload.courses.length,
      dayCounts,
      sectionReferences,
      weekReferences,
      normalizedLists: true,
      payloadBytes: utf8ByteLength(JSON.stringify(payload)),
      uploadMode: "replace-all",
      uploadRequestCount: 1,
      generatedTableCapacity: {
        maxSection: LIMITS.maxSection,
        maxWeek: LIMITS.maxWeek
      },
      settingsIncluded: true,
      totalWeek: payload.schedule.totalWeek,
      sectionTimeCount: payload.schedule.sections.length
    };
  }

  function parseUserInfo(value) {
    if (value && typeof value === "object") return value;
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch (_) { return null; }
    }
    return null;
  }

  async function getAuthorization() {
    if (!window.jsBridge) throw new Error("BRIDGE_UNAVAILABLE");
    if (typeof window.jsBridge.getUserInfo === "function") {
      try {
        const userInfo = parseUserInfo(await window.jsBridge.getUserInfo());
        if (userInfo && typeof userInfo.authorization === "string" && userInfo.authorization) {
          return userInfo.authorization;
        }
      } catch (_) {}
    }
    throw new Error("MODERN_AUTHORIZATION_UNAVAILABLE");
  }

  async function request(method, path, body, onFetchStart) {
    const authorization = await getAuthorization();
    let serializedBody;
    try {
      serializedBody = body ? JSON.stringify(body) : undefined;
    } catch (_) {
      const error = new Error("REQUEST_SERIALIZATION_FAILED");
      error.name = "RequestSerializationError";
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    try {
      if (typeof onFetchStart === "function") onFetchStart();
      const response = await fetch(path, {
        method,
        credentials: "include",
        cache: "no-store",
        headers: {
          "Accept": "application/json",
          "Authorization": authorization,
          "Content-Type": "application/json",
          "RequestId": requestId(),
          "X-Requested-With": "com.miui.voiceassist"
        },
        body: serializedBody,
        signal: controller.signal
      });
      let text;
      try {
        text = await response.text();
      } catch (_) {
        const error = new Error("RESPONSE_BODY_UNAVAILABLE");
        error.name = "ResponseReadError";
        throw error;
      }
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { httpStatus: response.status, ok: response.ok, responseLength: text.length, json };
    } finally {
      clearTimeout(timer);
    }
  }

  function requestFailureCode(error) {
    if (error && error.name === "RequestSerializationError") return "LOCAL_SERIALIZATION_ERROR";
    if (error && error.name === "AbortError") return "REQUEST_TIMEOUT";
    if (error && error.name === "ResponseReadError") return "RESPONSE_BODY_UNAVAILABLE";
    return "REQUEST_FAILED";
  }

  function apiSuccess(result) {
    if (!result || !result.ok) return false;
    if (!result.json || typeof result.json !== "object") return true;
    if (result.json.status === -1) return false;
    if (!own(result.json, "code")) return true;
    return result.json.code === 0 || result.json.code === 200;
  }

  function responseSummary(result) {
    const json = result && result.json && typeof result.json === "object" ? result.json : null;
    if (!result) return { responseAvailable: false };
    return {
      httpStatus: result.httpStatus,
      ok: result.ok,
      responseLength: result.responseLength,
      rootKeys: json ? Object.keys(json).slice(0, 30) : [],
      apiSuccess: apiSuccess(result),
      code: json && typeof json.code === "number" ? json.code : undefined,
      dataType: json && own(json, "data") ? (Array.isArray(json.data) ? "array" : typeof json.data) : "absent",
      dataLength: json && Array.isArray(json.data) ? json.data.length : undefined
    };
  }

  async function listTables() {
    const result = await request(
      "GET",
      "/course-multi-auth/tables?requestId=" + requestId() + "&sourceName=" + encodeURIComponent(SOURCE_NAME)
    );
    return { result, tables: result.json && Array.isArray(result.json.data) ? result.json.data : [] };
  }

  async function tableDetail(tableId) {
    const result = await request(
      "GET",
      "/course-multi-auth/table?ctId=" + encodeURIComponent(String(tableId)) +
        "&requestId=" + requestId() + "&sourceName=" + encodeURIComponent(SOURCE_NAME)
    );
    return {
      result,
      data: result.json && result.json.data && typeof result.json.data === "object" ? result.json.data : null
    };
  }

  function currentState(listed) {
    const currentTables = listed.tables.filter(isCurrent);
    const currentId = currentTables.length === 1 ? tableIdOf(currentTables[0]) : null;
    return {
      apiSuccess: apiSuccess(listed.result),
      tableCount: listed.tables.length,
      currentTableCount: currentTables.length,
      currentId,
      valid: apiSuccess(listed.result) && currentTables.length === 1 && idPresent(currentId)
    };
  }

  function currentSummary(state) {
    return {
      attempts: state.attempts,
      stableReads: state.stableReads,
      tableCount: state.tableCount,
      currentTableCount: state.currentTableCount,
      apiSuccess: state.apiSuccess,
      expectedCurrentVerified: state.stable
    };
  }

  async function waitForCurrent(expectedTableId) {
    const needsExpected = idPresent(expectedTableId);
    let previous = null;
    let stableReads = 0;
    let last = { apiSuccess: false, tableCount: 0, currentTableCount: 0, currentId: null };
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await pause(POLL_INTERVAL_MS);
      try {
        const state = currentState(await listTables());
        last = state;
        const matches = state.valid && (!needsExpected || String(state.currentId) === String(expectedTableId));
        const current = matches ? String(state.currentId) : null;
        stableReads = matches && current === previous ? stableReads + 1 : (matches ? 1 : 0);
        previous = current;
        if (stableReads >= STABLE_READS) {
          return Object.assign({}, state, { stable: true, attempts: attempt, stableReads });
        }
      } catch (_) {
        previous = null;
        stableReads = 0;
      }
    }
    return Object.assign({}, last, { stable: false, attempts: POLL_ATTEMPTS, stableReads });
  }

  async function readEveryTable(listed) {
    const records = [];
    let failures = 0;
    for (const table of listed.tables) {
      const tableId = tableIdOf(table);
      if (!idPresent(tableId)) {
        failures += 1;
        continue;
      }
      let detail;
      try { detail = await tableDetail(tableId); } catch (_) {
        failures += 1;
        continue;
      }
      if (!apiSuccess(detail.result) || !detail.data) {
        failures += 1;
        continue;
      }
      records.push({
        table,
        tableId,
        detail: detail.data,
        courses: Array.isArray(detail.data.courses) ? detail.data.courses : []
      });
    }
    return { complete: apiSuccess(listed.result) && failures === 0 && records.length === listed.tables.length, records, failures };
  }

  async function captureBaseline() {
    const current = await waitForCurrent(null);
    if (!current.stable) {
      add("capture-baseline", "BLOCKED", { current: currentSummary(current), reason: "CURRENT_TABLE_UNSTABLE" });
      return false;
    }
    let listed;
    try { listed = await listTables(); } catch (_) {
      add("capture-baseline", "BLOCKED", { reason: "TABLE_LIST_UNAVAILABLE" });
      return false;
    }
    const state = currentState(listed);
    if (!state.valid || String(state.currentId) !== String(current.currentId)) {
      add("capture-baseline", "BLOCKED", { reason: "CURRENT_TABLE_CHANGED_DURING_BASELINE" });
      return false;
    }
    const nameCollisions = listed.tables.filter(function (table) {
      return table && table.name === preparedPayload.tableName;
    }).length;
    if (nameCollisions) {
      add("capture-baseline", "BLOCKED", { reason: "TABLE_NAME_ALREADY_EXISTS", exactNameMatchCount: nameCollisions });
      return false;
    }
    const scan = await readEveryTable(listed);
    const allIdsPresent = scan.records.every(function (record) {
      return record.courses.every(function (course) { return course && idPresent(course.id); });
    });
    if (!scan.complete || !allIdsPresent) {
      add("capture-baseline", "BLOCKED", {
        reason: "INCOMPLETE_COURSE_BASELINE",
        tableCount: listed.tables.length,
        tablesRead: scan.records.length,
        readFailures: scan.failures,
        allCourseIdsPresent: allIdsPresent
      });
      return false;
    }
    originalTableId = state.currentId;
    baselineTableIds = new Set(scan.records.map(function (record) { return String(record.tableId); }));
    baselineCourseIds = new Map();
    scan.records.forEach(function (record) {
      baselineCourseIds.set(String(record.tableId), new Set(record.courses.map(function (course) { return String(course.id); })));
    });
    add("capture-baseline", "CAPTURED", {
      tableCount: scan.records.length,
      courseCount: scan.records.reduce(function (sum, record) { return sum + record.courses.length; }, 0),
      currentTableStableReads: current.stableReads,
      originalTableIdPresent: true
    });
    return true;
  }

  async function inspectGeneratedTable() {
    if (!generatedOwnershipProven || !idPresent(generatedTableId)) {
      return { ready: false, ownershipProven: false, ownedTableMatchCount: 0, table: null, courses: [] };
    }
    let listed;
    try { listed = await listTables(); } catch (_) {
      return { ready: false, ownershipProven: true, ownedTableMatchCount: 0, table: null, courses: [] };
    }
    const matches = listed.tables.filter(function (table) {
      const tableId = tableIdOf(table);
      return table && table.name === preparedPayload.tableName && idPresent(tableId) &&
        String(tableId) === String(generatedTableId) && !baselineTableIds.has(String(tableId));
    });
    const table = matches.length === 1 ? matches[0] : null;
    const tableId = tableIdOf(table);
    let detail = null;
    if (idPresent(tableId)) {
      try { detail = await tableDetail(tableId); } catch (_) {}
    }
    const courses = detail && detail.data && Array.isArray(detail.data.courses) ? detail.data.courses : [];
    const settingId = table && table.setting && table.setting.id;
    return {
      ready: apiSuccess(listed.result) && matches.length === 1 && !!table && !isCurrent(table) &&
        idPresent(tableId) && idPresent(settingId) && !!detail && apiSuccess(detail.result) && !!detail.data &&
        courses.length === 0,
      ownershipProven: true,
      ownedTableMatchCount: matches.length,
      table,
      tableId,
      settingId,
      courses,
      listApiSuccess: apiSuccess(listed.result)
    };
  }

  async function createGeneratedTable() {
    tableCreateStarted = true;
    if (!writeJournal("TABLE_CREATE_REQUEST_STARTED", false)) {
      tableCreateStarted = false;
      add("create-table", "BLOCKED", { reason: "JOURNAL_STAGE_WRITE_FAILED", writeRequestMade: false });
      return false;
    }
    let result = null;
    try {
      result = await request("POST", "/course-multi-auth/table", {
        name: preparedPayload.tableName,
        current: 0,
        sourceName: SOURCE_NAME
      });
    } catch (error) {
      add("create-table", "RESPONSE_UNAVAILABLE", {
        requestStarted: true,
        responseReceived: false,
        failureCode: requestFailureCode(error)
      });
    }
    const responseTableId = result && result.json ? responseIdOf(result.json.data) : null;
    if (apiSuccess(result) && idPresent(responseTableId) && !baselineTableIds.has(String(responseTableId))) {
      generatedTableId = responseTableId;
      generatedOwnershipProven = true;
      if (!writeJournal("TABLE_OWNERSHIP_PROVEN", false)) {
        add("create-table", "OWNERSHIP_JOURNAL_UNAVAILABLE", {
          request: responseSummary(result),
          createResponseIdPresent: true,
          recoveryWillRunInCurrentSession: true
        });
        return false;
      }
    }
    if (!generatedOwnershipProven) {
      add("create-table", "OWNERSHIP_UNPROVEN", {
        request: responseSummary(result),
        createResponseIdPresent: idPresent(responseTableId),
        generatedTableIdPresent: false,
        recoveryRequiresManualInspection: true
      });
      return false;
    }
    let inspection = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await pause(POLL_INTERVAL_MS);
      inspection = await inspectGeneratedTable();
      attempts = attempt;
      if (inspection.ready) break;
    }
    if (inspection && inspection.ready) {
      generatedSettingId = inspection.settingId;
    }
    add("create-table", inspection && inspection.ready ? "CREATED" : "CREATED_UNVERIFIED", {
      request: responseSummary(result),
      attempts,
      ownedGeneratedTableMatchCount: inspection ? inspection.ownedTableMatchCount : 0,
      ownershipProvenByCreateResponse: generatedOwnershipProven,
      generatedTableIdPresent: idPresent(generatedTableId),
      generatedSettingIdPresent: idPresent(generatedSettingId),
      initialCourseCount: inspection ? inspection.courses.length : 0
    });
    return !!(inspection && inspection.ready);
  }

  async function resolveSupportedProfile() {
    const profiles = Array.isArray(window.__XIAOAI_IMPORTER_PROFILES__) ? window.__XIAOAI_IMPORTER_PROFILES__ : [];
    if (!window.jsBridge || typeof window.jsBridge.getAppVersion !== "function") return null;
    let appVersion = null;
    try { appVersion = String(await window.jsBridge.getAppVersion()); } catch (_) { return null; }
    const webViewMatch = /(?:Chrome|CriOS)\/(\d+)/.exec(navigator.userAgent || "");
    const webViewMajor = webViewMatch ? Number(webViewMatch[1]) : null;
    return profiles.find(function (profile) {
      return profile && profile.modernBridge === true && profile.settingWriteVerified === true &&
        Number.isInteger(profile.maxCourses) && profile.maxCourses >= 1 && profile.maxCourses <= LIMITS.maxCourses &&
        profile.origin === EXPECTED_ORIGIN && Array.isArray(profile.appVersions) &&
        profile.appVersions.map(String).indexOf(appVersion) !== -1 &&
        Array.isArray(profile.webViewMajors) && profile.webViewMajors.indexOf(webViewMajor) !== -1;
    }) || null;
  }

  function parseSettingObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.assign({}, value);
    if (typeof value !== "string") return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }

  function expectedSetting(existing) {
    const source = preparedPayload.schedule;
    const startSemester = Date.parse(source.startSemester + "T00:00:00+08:00");
    const sectionTimes = JSON.stringify(source.sections.map(function (slot) {
      return { i: slot.section, s: slot.startTime, e: slot.endTime };
    }));
    const extend = parseSettingObject(existing.extend);
    extend.startSemester = startSemester;
    const requestSetting = {
      id: generatedSettingId,
      presentWeek: Number.isFinite(Number(existing.presentWeek)) ? Number(existing.presentWeek) : 1,
      totalWeek: source.totalWeek,
      isWeekend: source.showWeekend ? 1 : 0,
      morningNum: source.forenoon,
      afternoonNum: source.afternoon,
      nightNum: source.night,
      speak: Number.isFinite(Number(existing.speak)) ? Number(existing.speak) : 1,
      weekStart: source.startWithSunday ? 7 : 1,
      extend: JSON.stringify(extend),
      startSemester: JSON.stringify(startSemester),
      school: typeof existing.school === "string" ? existing.school : JSON.stringify(existing.school || {}),
      sections: sectionTimes
    };
    return {
      requestSetting,
      expectedReadback: Object.assign({}, requestSetting, { sectionTimes })
    };
  }

  function settingComparison(actual, expected) {
    const fields = {
      id: !!actual && !!expected && String(actual.id) === String(expected.id),
      presentWeek: !!actual && !!expected && Number(actual.presentWeek) === Number(expected.presentWeek),
      totalWeek: !!actual && !!expected && Number(actual.totalWeek) === Number(expected.totalWeek),
      isWeekend: !!actual && !!expected && Number(actual.isWeekend) === Number(expected.isWeekend),
      morningNum: !!actual && !!expected && Number(actual.morningNum) === Number(expected.morningNum),
      afternoonNum: !!actual && !!expected && Number(actual.afternoonNum) === Number(expected.afternoonNum),
      nightNum: !!actual && !!expected && Number(actual.nightNum) === Number(expected.nightNum),
      speak: !!actual && !!expected && Number(actual.speak) === Number(expected.speak),
      weekStart: !!actual && !!expected && Number(actual.weekStart) === Number(expected.weekStart),
      extend: !!actual && !!expected &&
        stableJson(parseSettingObject(actual.extend)) === stableJson(parseSettingObject(expected.extend)),
      startSemester: !!actual && !!expected && Number(actual.startSemester) === Number(expected.startSemester),
      school: !!actual && !!expected && String(actual.school) === String(expected.school),
      sectionTimes: !!actual && !!expected && String(actual.sectionTimes) === String(expected.sectionTimes)
    };
    const names = Object.keys(fields);
    return {
      verified: names.every(function (name) { return fields[name]; }),
      matchedFieldCount: names.filter(function (name) { return fields[name]; }).length,
      expectedFieldCount: names.length,
      fields
    };
  }

  async function updateGeneratedSettings() {
    const profile = await resolveSupportedProfile();
    if (!profile) {
      add("write-setting", "BLOCKED", { reason: "NOT_SUPPORTED", verifiedProfilePresent: false });
      return false;
    }
    if (!writeJournal("SETTING_WRITE_REQUEST_STARTED", true)) {
      add("write-setting", "BLOCKED", { reason: "JOURNAL_STAGE_WRITE_FAILED" });
      return false;
    }
    const detailBefore = await tableDetail(generatedTableId);
    const existing = detailBefore.data && detailBefore.data.setting && typeof detailBefore.data.setting === "object"
      ? detailBefore.data.setting
      : {};
    const expected = expectedSetting(existing);
    const setting = expected.requestSetting;
    let result = null;
    let requestError = null;
    try {
      result = await request("PUT", "/course-multi-auth/table", {
        ctId: generatedTableId,
        name: preparedPayload.tableName,
        setting,
        sourceName: SOURCE_NAME
      });
    } catch (error) {
      requestError = error;
      add("write-setting", "RESPONSE_UNAVAILABLE", {
        responseReceived: false,
        failureCode: requestFailureCode(error)
      });
    }
    let detailAfter = null;
    try { detailAfter = await tableDetail(generatedTableId); } catch (_) {}
    const actual = detailAfter && detailAfter.data && detailAfter.data.setting;
    const comparison = settingComparison(actual, expected.expectedReadback);
    const verified = !!detailAfter && apiSuccess(detailAfter.result) && comparison.verified;
    if (verified && !writeJournal("SETTING_WRITE_VERIFIED", false)) {
      add("write-setting", "JOURNAL_UNAVAILABLE", {
        request: responseSummary(result),
        responseUnavailable: !!requestError,
        failureCode: requestError ? requestFailureCode(requestError) : undefined,
        readbackApiSuccess: true,
        allSettingFieldsMatch: true
      });
      return false;
    }
    add("write-setting", verified
      ? (requestError ? "RESPONSE_UNAVAILABLE_VERIFIED" : "VERIFIED")
      : "NOT_VERIFIED", {
      request: responseSummary(result),
      responseUnavailable: !!requestError,
      failureCode: requestError ? requestFailureCode(requestError) : undefined,
      writeResponseAccepted: apiSuccess(result),
      readbackApiSuccess: !!detailAfter && apiSuccess(detailAfter.result),
      allSettingFieldsMatch: verified,
      matchedSettingFieldCount: comparison.matchedFieldCount,
      expectedSettingFieldCount: comparison.expectedFieldCount,
      settingFieldMatches: comparison.fields
    });
    return verified;
  }

  async function switchTable(fromTableId, toTableId, operation) {
    const sourceCurrent = await waitForCurrent(fromTableId);
    let listed = null;
    try { listed = await listTables(); } catch (_) {}
    const tables = listed ? listed.tables : [];
    const source = tables.filter(function (table) { return String(tableIdOf(table)) === String(fromTableId); });
    const target = tables.filter(function (table) { return String(tableIdOf(table)) === String(toTableId); });
    const ready = sourceCurrent.stable && !!listed && apiSuccess(listed.result) && source.length === 1 &&
      target.length === 1 && isCurrent(source[0]) && !isCurrent(target[0]);
    add(operation + "-preflight", ready ? "READY" : "BLOCKED", {
      sourceCurrent: currentSummary(sourceCurrent),
      sourceMatchCount: source.length,
      targetMatchCount: target.length,
      sourceIsCurrent: isCurrent(source[0]),
      targetIsCurrent: isCurrent(target[0])
    });
    if (!ready) return false;
    let result = null;
    let requestError = null;
    try {
      result = await request("POST", "/course-multi-auth/table_switch", {
        fromCtId: fromTableId,
        toCtId: toTableId,
        sourceName: SOURCE_NAME
      });
    } catch (error) { requestError = error; }
    const settled = await waitForCurrent(toTableId);
    add(operation, settled.stable ? "VERIFIED" : "FAILED", {
      request: responseSummary(result),
      responseUnavailable: !!requestError,
      failureCode: requestError ? requestFailureCode(requestError) : undefined,
      targetCurrent: currentSummary(settled)
    });
    return settled.stable;
  }

  async function switchToGeneratedTable() {
    switchRequestStarted = true;
    if (!writeJournal("SWITCH_REQUEST_STARTED", false)) {
      switchRequestStarted = false;
      add("switch-to-generated-table", "BLOCKED", {
        reason: "JOURNAL_STAGE_WRITE_FAILED",
        writeRequestMade: false
      });
      return false;
    }
    switchedToGenerated = await switchTable(originalTableId, generatedTableId, "switch-to-generated-table");
    if (switchedToGenerated) writeJournal("SWITCH_VERIFIED", false);
    return switchedToGenerated;
  }

  function responseIdOf(value) {
    return value && typeof value === "object" ? value.id : value;
  }

  async function uploadCourses() {
    uploadRequestStarted = true;
    if (!writeJournal("UPLOAD_REQUEST_STARTED", false)) {
      uploadRequestStarted = false;
      add("upload-courses", "BLOCKED", { reason: "JOURNAL_STAGE_WRITE_FAILED", writeRequestMade: false });
      return false;
    }
    uploadRequestCount = 1;
    responseIds = [];
    let result = null;
    try {
      result = await request("POST", "/course-multi-auth/courseInfos", {
        ctId: generatedTableId,
        courses: preparedPayload.courses.map(function (course, courseIndex) {
          return Object.assign({}, courseForServer(course, courseIndex), { extend: transactionExtend() });
        }),
        sourceName: SOURCE_NAME
      }, function () {
        uploadNetworkStarted = true;
        writeJournal("UPLOAD_NETWORK_STARTED", false);
      });
    } catch (error) {
      add("upload-courses", "RESPONSE_UNAVAILABLE", {
        submittedCourseCount: preparedPayload.courses.length,
        responseReceived: false,
        readbackRequired: true,
        failureCode: requestFailureCode(error)
      });
      return false;
    }

    uploadResponseReceived = true;
    const data = result.json && Array.isArray(result.json.data) ? result.json.data : [];
    responseIds = data.map(responseIdOf).filter(idPresent).map(String);
    uploadAccepted = apiSuccess(result) && responseIds.length === preparedPayload.courses.length &&
      new Set(responseIds).size === responseIds.length;
    writeJournal("UPLOAD_RESPONSE_RECEIVED", true);
    add("upload-courses", uploadAccepted ? "REQUEST_ACCEPTED" : "RESPONSE_NOT_ACCEPTED", {
      uploadMode: "replace-all",
      response: responseSummary(result),
      submittedCourseCount: preparedPayload.courses.length,
      returnedCourseIdCount: responseIds.length,
      returnedIdsDistinct: new Set(responseIds).size === responseIds.length,
      persistenceRequiresReadback: true
    });
    return uploadAccepted;
  }

  function verifyCourses(courses) {
    const assignments = preparedPayload.courses.map(function (spec) {
      return courses.filter(function (course) {
        if (!idPresent(course && course.ctId) || String(course.ctId) !== String(generatedTableId)) return false;
        if (!matchesSpec(course, spec)) return false;
        if (typeof course.extend !== "string") return false;
        try {
          const marker = JSON.parse(course.extend).xiaoaiImporter;
          return marker && marker.transactionId === sessionMarker && marker.payloadHash === payloadHash;
        } catch (_) { return false; }
      });
    });
    const exactOnePerCourse = assignments.every(function (matches) { return matches.length === 1; });
    const matchedCourses = exactOnePerCourse ? assignments.map(function (matches) { return matches[0]; }) : [];
    const ids = matchedCourses.map(function (course) { return course.id; }).filter(idPresent).map(String);
    const allIdsPresent = ids.length === preparedPayload.courses.length && new Set(ids).size === ids.length;
    const allTableIdsMatch = matchedCourses.length === preparedPayload.courses.length && matchedCourses.every(function (course) {
      return idPresent(course.ctId) && String(course.ctId) === String(generatedTableId);
    });
    const responseIdsMatch = !uploadResponseReceived
      ? undefined
      : responseIds.length === ids.length && responseIds.slice().sort().every(function (id, index) {
        return id === ids.slice().sort()[index];
      });
    return {
      verified: courses.length === preparedPayload.courses.length && exactOnePerCourse && allIdsPresent && allTableIdsMatch &&
        (!uploadResponseReceived || responseIdsMatch === true),
      exactOnePerCourse,
      allIdsPresent,
      allTableIdsMatch,
      responseIdsMatch,
      readbackCourseCount: courses.length,
      matchedCourseCount: matchedCourses.length
    };
  }

  async function verifyImport() {
    let verification = null;
    let detail = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await pause(POLL_INTERVAL_MS);
      try { detail = await tableDetail(generatedTableId); } catch (_) { detail = null; }
      const courses = detail && detail.data && Array.isArray(detail.data.courses) ? detail.data.courses : [];
      verification = detail && apiSuccess(detail.result) && detail.data
        ? verifyCourses(courses)
        : { verified: false, exactOnePerCourse: false, allIdsPresent: false, readbackCourseCount: 0, matchedCourseCount: 0 };
      attempts = attempt;
      if (verification.verified) break;
    }
    const current = await waitForCurrent(generatedTableId);
    importVerified = !!verification && verification.verified && current.stable;
    add("verify-import", importVerified ? "VERIFIED" : "NOT_VERIFIED", {
      attempts,
      expectedCourseCount: preparedPayload.courses.length,
      readbackCourseCount: verification ? verification.readbackCourseCount : 0,
      matchedCourseCount: verification ? verification.matchedCourseCount : 0,
      exactlyOneMatchPerCourse: !!(verification && verification.exactOnePerCourse),
      allReadbackIdsPresent: !!(verification && verification.allIdsPresent),
      allReadbackTableIdsMatch: !!(verification && verification.allTableIdsMatch),
      returnedIdsMatchReadback: verification ? verification.responseIdsMatch : undefined,
      generatedTableRemainsCurrent: current.stable
    });
    return importVerified;
  }

  function isBaselineCourse(tableId, courseId) {
    const ids = baselineCourseIds.get(String(tableId));
    return !!ids && ids.has(String(courseId));
  }

  function matchingSpec(course) {
    return preparedPayload.courses.find(function (spec) { return matchesSpec(course, spec); }) || null;
  }

  function cleanupDisposition(record) {
    const course = record.course;
    const courseIdPresent = !!course && idPresent(course.id);
    const newToBaseline = courseIdPresent && !isBaselineCourse(record.tableId, course.id);
    const belongsToContainingTable = !!course && idPresent(course.ctId) &&
      String(course.ctId) === String(record.tableId);
    const responseIdMatch = courseIdPresent && responseIds.indexOf(String(course.id)) !== -1;
    const fingerprintMatch = !!course && !!matchingSpec(course);
    const onOwnedGeneratedTable = generatedOwnershipProven && idPresent(generatedTableId) &&
      String(record.tableId) === String(generatedTableId);
    const candidate = newToBaseline && belongsToContainingTable && (
      responseIdMatch || (onOwnedGeneratedTable && fingerprintMatch)
    );
    const unresolved = !candidate && !isBaselineCourse(record.tableId, course && course.id) &&
      (responseIdMatch || fingerprintMatch);
    return { candidate, unresolved, responseIdMatch, fingerprintMatch, onOwnedGeneratedTable };
  }

  function isCleanupCandidate(record) {
    return cleanupDisposition(record).candidate;
  }

  async function scanCleanupCandidates() {
    let listed;
    try { listed = await listTables(); } catch (_) {
      return { complete: false, records: [], unresolvedCount: 0, tableCount: 0, tablesRead: 0, failures: 1 };
    }
    const scan = await readEveryTable(listed);
    const records = [];
    let unresolvedCount = 0;
    scan.records.forEach(function (record) {
      record.courses.forEach(function (course) {
        const candidate = { tableId: record.tableId, course };
        const disposition = cleanupDisposition(candidate);
        if (disposition.candidate) records.push(candidate);
        else if (disposition.unresolved) unresolvedCount += 1;
      });
    });
    return {
      complete: scan.complete,
      records,
      unresolvedCount,
      tableCount: listed.tables.length,
      tablesRead: scan.records.length,
      failures: scan.failures
    };
  }

  function sameStrings(left, right) {
    const a = left.map(String).sort();
    const b = right.map(String).sort();
    return a.length === b.length && a.every(function (value, index) { return value === b[index]; });
  }

  async function deleteCandidate(record) {
    if (destructiveRecoveryBlocked) {
      add("delete-imported-course", "BLOCKED", { reason: "DESTRUCTIVE_RECOVERY_FROZEN" });
      return false;
    }
    let before;
    try { before = await tableDetail(record.tableId); } catch (_) {
      add("delete-imported-course", "PREFLIGHT_FAILED", { candidateIdPresent: true });
      return false;
    }
    const beforeCourses = before.data && Array.isArray(before.data.courses) ? before.data.courses : [];
    const targets = beforeCourses.filter(function (course) {
      return course && String(course.id) === String(record.course.id) &&
        isCleanupCandidate({ tableId: record.tableId, course });
    });
    const siblingIds = beforeCourses.filter(function (course) {
      return course && idPresent(course.id) && String(course.id) !== String(record.course.id);
    }).map(function (course) { return String(course.id); });
    if (!apiSuccess(before.result) || targets.length !== 1) {
      add("delete-imported-course", "BLOCKED", { exactSafeCandidateCount: targets.length });
      return false;
    }
    let deleted = null;
    try {
      deleted = await request("DELETE", "/course-multi-auth/courseInfo", {
        ctId: record.tableId,
        cId: record.course.id,
        sourceName: SOURCE_NAME
      });
    } catch (_) {}
    let after;
    try { after = await tableDetail(record.tableId); } catch (_) {
      add("delete-imported-course", "DELETE_UNVERIFIED", { request: responseSummary(deleted) });
      return false;
    }
    const afterCourses = after.data && Array.isArray(after.data.courses) ? after.data.courses : [];
    const remains = afterCourses.some(function (course) { return course && String(course.id) === String(record.course.id); });
    const afterSiblingIds = afterCourses.filter(function (course) {
      return course && idPresent(course.id) && String(course.id) !== String(record.course.id);
    }).map(function (course) { return String(course.id); });
    const verified = apiSuccess(after.result) && !remains && afterCourses.length === beforeCourses.length - 1 &&
      sameStrings(siblingIds, afterSiblingIds);
    add("delete-imported-course", verified ? "DELETED" : "FAILED", {
      request: responseSummary(deleted),
      targetStillPresent: remains,
      exactlyOneCourseRemoved: afterCourses.length === beforeCourses.length - 1,
      siblingCourseIdsUnchanged: sameStrings(siblingIds, afterSiblingIds),
      deleteVerified: verified
    });
    return verified;
  }

  async function cleanupImportedCourses() {
    if (!uploadNetworkStarted) {
      add("cleanup-imported-courses", "NOT_REQUIRED", { uploadNetworkStarted: false });
      return true;
    }
    let scan;
    try {
      scan = await scanCleanupCandidates();
    } catch (_) {
      cleanupScanComplete = false;
      destructiveRecoveryBlocked = true;
      add("cleanup-imported-courses", "ATTENTION_REQUIRED", {
        reason: "ALL_TABLE_SCAN_ERROR_DELETIONS_FROZEN",
        courseDeleteRequestsMade: 0,
        tableDeleteRequestsAllowed: false
      });
      return false;
    }
    cleanupScanComplete = scan.complete;
    unresolvedFingerprintResidueCount = scan.unresolvedCount;
    if (!scan.complete) {
      destructiveRecoveryBlocked = true;
      add("cleanup-imported-courses", "ATTENTION_REQUIRED", {
        reason: "ALL_TABLE_SCAN_INCOMPLETE_DELETIONS_FROZEN",
        tableCount: scan.tableCount,
        tablesRead: scan.tablesRead,
        readFailures: scan.failures,
        courseDeleteRequestsMade: 0,
        tableDeleteRequestsAllowed: false
      });
      return false;
    }
    let allDeleted = scan.unresolvedCount === 0;
    for (const record of scan.records) {
      allDeleted = (await deleteCandidate(record)) && allDeleted;
    }
    add("cleanup-imported-courses", allDeleted ? "COMPLETE" : "ATTENTION_REQUIRED", {
      safeCandidateCount: scan.records.length,
      unresolvedFingerprintCount: scan.unresolvedCount,
      allCandidatesDeleted: allDeleted
    });
    return allDeleted;
  }

  async function restoreOriginalTable() {
    if (!idPresent(originalTableId)) {
      add("restore-original-table", "NOT_AVAILABLE", { originalTableIdPresent: false });
      return false;
    }
    const current = await waitForCurrent(null);
    if (!current.stable) {
      add("restore-original-table", "BLOCKED_UNSTABLE_CURRENT", currentSummary(current));
      return false;
    }
    if (String(current.currentId) === String(originalTableId)) {
      originalRestored = true;
      add("restore-original-table", "ALREADY_CURRENT", { current: currentSummary(current) });
      return true;
    }
    if (!idPresent(generatedTableId) || String(current.currentId) !== String(generatedTableId)) {
      add("restore-original-table", "BLOCKED_EXTERNAL_CURRENT", {
        currentIsGeneratedTable: idPresent(generatedTableId) && String(current.currentId) === String(generatedTableId)
      });
      return false;
    }
    originalRestored = await switchTable(generatedTableId, originalTableId, "restore-original-table");
    return originalRestored;
  }

  async function rediscoverGeneratedTable() {
    if (!generatedOwnershipProven || !idPresent(generatedTableId)) {
      return { listAvailable: true, ownershipProven: false, matches: [], ownedIdMatchCount: 0 };
    }
    let listed;
    try { listed = await listTables(); } catch (_) {
      return { listAvailable: false, ownershipProven: true, matches: [], ownedIdMatchCount: 0 };
    }
    const ownedIdMatches = listed.tables.filter(function (table) {
      const tableId = tableIdOf(table);
      return table && idPresent(tableId) && String(tableId) === String(generatedTableId);
    });
    const matches = ownedIdMatches.filter(function (table) {
      return table.name === preparedPayload.tableName && !baselineTableIds.has(String(tableIdOf(table)));
    });
    if (matches.length === 1 && idPresent(matches[0].setting && matches[0].setting.id)) {
      generatedSettingId = matches[0].setting.id;
    }
    return {
      listAvailable: apiSuccess(listed.result),
      ownershipProven: true,
      matches,
      ownedIdMatchCount: ownedIdMatches.length,
      listed
    };
  }

  async function deleteGeneratedTable() {
    if (!tableCreateStarted) {
      generatedTableDeleted = true;
      add("delete-generated-table", "NOT_REQUIRED", { createRequestStarted: false });
      return true;
    }
    if (destructiveRecoveryBlocked) {
      add("delete-generated-table", "ATTENTION_REQUIRED", {
        reason: "ALL_TABLE_SCAN_INCOMPLETE_DELETIONS_FROZEN",
        tableDeleteRequestsMade: 0
      });
      return false;
    }
    const discovered = await rediscoverGeneratedTable();
    if (!discovered.listAvailable) {
      add("delete-generated-table", "LIST_UNAVAILABLE", {});
      return false;
    }
    if (!discovered.ownershipProven) {
      add("delete-generated-table", "BLOCKED_OWNERSHIP_UNPROVEN", {
        createResponseOwnershipAvailable: false
      });
      return false;
    }
    if (!discovered.matches.length && discovered.ownedIdMatchCount === 0) {
      generatedTableDeleted = true;
      add("delete-generated-table", "NOT_PRESENT", { deleteVerified: true });
      return true;
    }
    if (discovered.matches.length !== 1 || discovered.ownedIdMatchCount !== 1 || !idPresent(generatedTableId)) {
      add("delete-generated-table", "BLOCKED_OWNERSHIP_CHANGED", {
        ownedIdMatchCount: discovered.ownedIdMatchCount,
        ownedIdAndNameMatchCount: discovered.matches.length
      });
      return false;
    }
    if (!originalRestored) {
      add("delete-generated-table", "BLOCKED_ORIGINAL_NOT_RESTORED", {});
      return false;
    }
    const current = await waitForCurrent(originalTableId);
    const table = discovered.matches[0];
    if (!current.stable || isCurrent(table) || !idPresent(generatedSettingId)) {
      add("delete-generated-table", "BLOCKED_PREFLIGHT", {
        originalCurrentStable: current.stable,
        generatedTableCurrent: isCurrent(table),
        generatedSettingIdPresent: idPresent(generatedSettingId)
      });
      return false;
    }
    let detail;
    try { detail = await tableDetail(generatedTableId); } catch (_) {
      add("delete-generated-table", "DETAIL_UNAVAILABLE", {});
      return false;
    }
    const courses = detail.data && Array.isArray(detail.data.courses) ? detail.data.courses : [];
    const allRemainingSafe = courses.every(function (course) {
      return isCleanupCandidate({ tableId: generatedTableId, course });
    });
    if (!apiSuccess(detail.result) || !allRemainingSafe) {
      add("delete-generated-table", "BLOCKED_CONTENTS", {
        courseCount: courses.length,
        allRemainingCoursesBelongToImport: allRemainingSafe
      });
      return false;
    }
    let deleted = null;
    try {
      deleted = await request("DELETE", "/course-multi-auth/table", {
        ctId: generatedTableId,
        sId: generatedSettingId,
        sourceName: SOURCE_NAME
      });
    } catch (_) {}
    const after = await rediscoverGeneratedTable();
    generatedTableDeleted = after.listAvailable && after.ownershipProven && after.ownedIdMatchCount === 0;
    add("delete-generated-table", generatedTableDeleted ? "DELETED" : "FAILED", {
      request: responseSummary(deleted),
      cascadedSafeCourseCount: courses.length,
      deleteVerified: generatedTableDeleted
    });
    return generatedTableDeleted;
  }

  async function auditResidue() {
    if (!uploadNetworkStarted) {
      cleanupScanComplete = true;
      residueFree = true;
      add("residue-audit", "NOT_REQUIRED", { uploadNetworkStarted: false });
      return true;
    }
    let cleanReads = 0;
    let last = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await pause(POLL_INTERVAL_MS);
      last = await scanCleanupCandidates();
      attempts = attempt;
      cleanReads = last.complete && last.records.length === 0 && last.unresolvedCount === 0 ? cleanReads + 1 : 0;
      if (cleanReads >= STABLE_READS) break;
    }
    last = last || { complete: false, records: [], unresolvedCount: 0, tableCount: 0, tablesRead: 0, failures: 1 };
    cleanupScanComplete = last.complete;
    unresolvedFingerprintResidueCount = last.unresolvedCount;
    residueFree = cleanReads >= STABLE_READS;
    add("residue-audit", residueFree ? "NO_RECOGNIZED_RESIDUE" : "ATTENTION_REQUIRED", {
      attempts,
      stableCleanReads: cleanReads,
      tableCount: last.tableCount,
      tablesRead: last.tablesRead,
      readFailures: last.failures,
      recognizedResidueCount: last.records.length,
      unresolvedFingerprintResidueCount: last.unresolvedCount
    });
    return residueFree;
  }

  async function recoverFailure() {
    if (tableCreateStarted) {
      try {
        const discovered = await rediscoverGeneratedTable();
        add("recovery-table-discovery", discovered.listAvailable ? "COMPLETE" : "UNAVAILABLE", {
          ownershipProven: discovered.ownershipProven,
          ownedIdMatchCount: discovered.ownedIdMatchCount,
          ownedIdAndNameMatchCount: discovered.matches.length,
          generatedTableIdPresent: idPresent(generatedTableId),
          generatedSettingIdPresent: idPresent(generatedSettingId)
        });
      } catch (_) {
        add("recovery-table-discovery", "ERROR", { reason: "UNEXPECTED_ERROR" });
      }
    }
    try { await cleanupImportedCourses(); }
    catch (_) {
      cleanupScanComplete = false;
      destructiveRecoveryBlocked = true;
      add("cleanup-imported-courses", "ATTENTION_REQUIRED", {
        reason: "UNEXPECTED_ERROR_DELETIONS_FROZEN",
        courseDeleteRequestsMade: 0,
        tableDeleteRequestsAllowed: false
      });
    }
    try { await restoreOriginalTable(); }
    catch (_) { add("restore-original-table", "ERROR", { reason: "UNEXPECTED_ERROR" }); }
    try { await deleteGeneratedTable(); }
    catch (_) { add("delete-generated-table", "ERROR", { reason: "UNEXPECTED_ERROR" }); }
    try { await auditResidue(); }
    catch (_) { add("residue-audit", "ERROR", { reason: "UNEXPECTED_ERROR" }); }
  }

  function prepare(payload) {
    if (manualReviewReloadRequired) {
      add("prepare", "BLOCKED", { reason: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW" });
      return { status: "BLOCKED", errors: [{ path: "$", code: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW" }] };
    }
    if (journalBlocked) {
      add("prepare", "BLOCKED", { reason: "JOURNAL_INCOMPLETE", sessionMarker });
      return { status: "BLOCKED", errors: [{ path: "$", code: "JOURNAL_INCOMPLETE" }], sessionMarker };
    }
    if (operationRunning || commitStarted) {
      add("prepare", "BLOCKED", { reason: "COMMIT_ALREADY_STARTED" });
      return { status: "BLOCKED", errors: [{ path: "$", code: "COMMIT_ALREADY_STARTED" }] };
    }
    const result = normalizePayload(payload);
    validationErrors = result.errors.slice();
    preparedPayload = result.normalized;
    if (!preparedPayload) {
      preparedSummary = null;
      finalStatus = "VALIDATION_FAILED";
      const summary = { status: "INVALID", errorCount: validationErrors.length, errors: validationErrors.slice() };
      add("prepare", "INVALID", summary);
      return summary;
    }
    preparedSummary = makePreparedSummary(preparedPayload);
    finalStatus = "READY";
    add("prepare", "READY", preparedSummary);
    return Object.assign({}, preparedSummary);
  }

  function report() {
    const redactedJournal = journalState ? {
      schemaVersion: journalState.schemaVersion,
      unfinished: journalState.unfinished,
      sessionMarkerPresent: typeof journalState.sessionMarker === "string",
      createdAt: journalState.createdAt,
      updatedAt: journalState.updatedAt,
      stage: journalState.stage,
      contractVersion: journalState.contractVersion,
      courseCount: journalState.courseCount,
      tableNameLength: journalState.tableNameLength,
      tableCreateStarted: journalState.tableCreateStarted,
      switchRequestStarted: journalState.switchRequestStarted,
      uploadNetworkStarted: journalState.uploadNetworkStarted,
      importVerified: journalState.importVerified,
      recoveryRequired: journalState.recoveryRequired,
      payloadHashPresent: typeof journalState.payloadHash === "string",
      originalTableIdPresent: idPresent(journalState.originalTableId),
      generatedTableIdPresent: idPresent(journalState.generatedTableId),
      generatedSettingIdPresent: idPresent(journalState.generatedSettingId),
      returnedCourseIdCount: Array.isArray(journalState.responseIds) ? journalState.responseIds.length : 0
    } : null;
    return {
      name: "XiaoAi schedule importer",
      version: "2.0.0-gate0",
      createdAt,
      elapsedMs: Date.now() - Date.parse(createdAt),
      page: {
        originMatchesExpected: location.origin === EXPECTED_ORIGIN,
        path: location.pathname,
        hashPresent: !!location.hash
      },
      state: {
        prepared: !!preparedPayload,
        validationErrorCount: validationErrors.length,
        preparedCourseCount: preparedPayload ? preparedPayload.courses.length : 0,
        profileMaxCourses,
        commitStarted,
        operationRunning,
        tableCreateStarted,
        switchRequestStarted,
        uploadRequestStarted,
        uploadNetworkStarted,
        uploadResponseReceived,
        uploadAccepted,
        uploadMode: "replace-all",
        uploadRequestCount,
        returnedCourseIdCount: responseIds.length,
        originalTableIdPresent: idPresent(originalTableId),
        generatedTableIdPresent: idPresent(generatedTableId),
        generatedSettingIdPresent: idPresent(generatedSettingId),
        generatedOwnershipProven,
        switchedToGenerated,
        importVerified,
        originalRestored,
        generatedTableDeleted,
        residueFree,
        cleanupScanComplete,
        destructiveRecoveryBlocked,
        unresolvedFingerprintResidueCount,
        recoveryAttempts,
        manualReviewAcknowledged,
        manualReviewReloadRequired,
        journalAvailable,
        journalIncomplete: !!journalState,
        finalStatus
      },
      journal: redactedJournal,
      preparedSummary: preparedSummary ? Object.assign({}, preparedSummary) : null,
      validationErrors: validationErrors.slice(),
      history: history.slice(),
      safety: [
        "Installation performs no request; prepare(payload) only validates and normalizes in memory.",
        "commit() is one-shot and writes only after a complete all-table baseline and stable current-table checks.",
        "The generated table is made current before one replace-all courseInfos request containing the complete normalized course set; success requires a complete GET readback.",
        "A verified import keeps the generated table current unless cleanupVerifiedImport() is explicitly called in the same proven-ownership session.",
        "An incomplete all-table scan freezes every course and table deletion for that recovery attempt.",
        "Outside the create-response-owned generated table, cleanup requires an exact course ID returned by the replace-all POST; a fingerprint alone is never deleted.",
        "Generated-table ownership comes only from the create response ID held in memory. A table name is never used as deletion ownership proof.",
        "The localStorage journal contains recovery IDs and hashes but no authorization or raw schedule text; reports redact every stored ID and hash.",
        "The complete generated-table setting is written and accepted only for a separately verified Xiaomi application profile.",
        "Authorization values, table IDs, course IDs, raw table/course values, request bodies, and response bodies are never included in logs or reports."
      ]
    };
  }

  async function copy() {
    const text = JSON.stringify(report(), null, 2);
    let copied = false;
    if (typeof navigator !== "undefined" && navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (_) {}
    }
    if (!copied && typeof document !== "undefined" && document.body &&
      typeof document.execCommand === "function") {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        copied = document.execCommand("copy") !== false;
      } finally {
        area.remove();
      }
    }
    if (!copied) {
      console.error("XIAOAI_IMPORTER_COPY_FAILED: clipboard is unavailable");
      throw new Error("CLIPBOARD_UNAVAILABLE");
    }
    console.log("XIAOAI_IMPORTER_COPIED: " + history.length + " sanitized records");
    return undefined;
  }

  async function autoCopy() {
    if (window.__XIAOAI_IMPORTER_DISABLE_AUTO_COPY__ === true) return true;
    try {
      await copy();
      return true;
    } catch (_) {
      console.log("XIAOAI_IMPORTER_REPORT_JSON:\n" + JSON.stringify(report(), null, 2));
      console.error("XIAOAI_IMPORTER_AUTO_COPY_FAILED: copy the sanitized XIAOAI_IMPORTER_REPORT_JSON console output");
      return false;
    }
  }

  async function commit() {
    if (manualReviewReloadRequired) {
      add("commit", "BLOCKED", { reason: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW", writeRequestsMade: 0 });
      return report();
    }
    if (journalBlocked) {
      add("commit", "BLOCKED", { reason: "JOURNAL_INCOMPLETE", sessionMarker });
      finalStatus = "JOURNAL_INCOMPLETE";
      await autoCopy();
      console.log("XIAOAI_IMPORTER_DONE: " + finalStatus);
      return report();
    }
    if (operationRunning || commitStarted) {
      add("commit", "BLOCKED", { reason: "COMMIT_ALREADY_STARTED" });
      return report();
    }
    if (!preparedPayload) {
      add("commit", "BLOCKED", { reason: "NO_VALID_PREPARED_PAYLOAD" });
      finalStatus = "NOT_PREPARED";
      await autoCopy();
      console.log("XIAOAI_IMPORTER_DONE: " + finalStatus);
      return report();
    }
    operationRunning = true;
    commitStarted = true;
    finalStatus = "RUNNING";
    add("commit", "STARTED", { courseCount: preparedPayload.courses.length });
    let proceed = location.origin === EXPECTED_ORIGIN;
    if (!proceed) add("origin-check", "BLOCKED", { expectedOrigin: EXPECTED_ORIGIN, actualOriginMatches: false });
    try {
      if (proceed) {
        payloadHash = await sha256Text(stableJson(preparedPayload));
        const profile = await resolveSupportedProfile();
        if (!profile) {
          operationRunning = false;
          finalStatus = "NOT_SUPPORTED";
          add("profile-check", "BLOCKED", { reason: "NOT_SUPPORTED", modernBridge5Required: true });
          add("commit", finalStatus, { writeRequestsMade: 0 });
          await autoCopy();
          console.log("XIAOAI_IMPORTER_DONE: " + finalStatus);
          return report();
        } else {
          profileMaxCourses = profile.maxCourses;
          if (preparedPayload.courses.length > profileMaxCourses) {
            operationRunning = false;
            finalStatus = "PROFILE_CAPACITY_NOT_SUPPORTED";
            add("profile-check", "BLOCKED", {
              reason: "COURSE_COUNT_EXCEEDS_PROFILE_CAPACITY",
              requestedCourseCount: preparedPayload.courses.length,
              verifiedMaxCourses: profileMaxCourses
            });
            add("commit", finalStatus, {
              requestedCourseCount: preparedPayload.courses.length,
              verifiedMaxCourses: profileMaxCourses,
              writeRequestsMade: 0
            });
            await autoCopy();
            console.log("XIAOAI_IMPORTER_DONE: " + finalStatus);
            return report();
          }
          add("profile-check", "SUPPORTED", {
            settingWriteVerified: true,
            maxCourses: profileMaxCourses
          });
        }
      }
      if (proceed) proceed = await captureBaseline();
      if (proceed && !writeJournal("WRITE_PREFLIGHT_COMPLETE", false)) {
        operationRunning = false;
        finalStatus = "JOURNAL_UNAVAILABLE";
        add("commit", "BLOCKED", {
          reason: "JOURNAL_WRITE_OR_VERIFY_FAILED",
          writeRequestsMade: 0
        });
        await autoCopy();
        console.log("XIAOAI_IMPORTER_DONE: " + finalStatus);
        return report();
      }
      if (proceed) proceed = await createGeneratedTable();
      if (proceed) proceed = await updateGeneratedSettings();
      if (proceed) proceed = await switchToGeneratedTable();
      if (proceed) {
        await uploadCourses();
        proceed = await verifyImport();
      }
    } catch (_) {
      proceed = false;
      add("commit-main", "ERROR", { reason: "UNEXPECTED_ERROR", recoveryWillRun: true });
    }
    if (proceed && importVerified) {
      const verifiedJournalPersisted = writeJournal("IMPORT_VERIFIED", false);
      if (!verifiedJournalPersisted) {
        const staleJournalCleared = clearJournal();
        if (!staleJournalCleared) {
          proceed = false;
          add("commit", "VERIFIED_JOURNAL_UNAVAILABLE", {
            reason: "VERIFIED_STAGE_WRITE_AND_CLEAR_FAILED",
            recoveryWillRun: true
          });
        } else {
          add("journal", "VERIFIED_STAGE_WRITE_FAILED_CLEARED", { sessionMarker });
        }
      }
    }
    if (proceed && importVerified) {
      finalStatus = "IMPORT_VERIFIED";
      add("commit", finalStatus, {
        importedCourseCount: preparedPayload.courses.length,
        generatedTableRemainsCurrent: true,
        cleanupPerformed: false
      });
      if (journalState && !clearJournal()) {
        add("journal", "CLEAR_FAILED", { sessionMarker });
      }
    } else {
      writeJournal("RECOVERY_RUNNING", true);
      await recoverFailure();
      const noTableCleanupNeeded = !tableCreateStarted || generatedTableDeleted;
      const originalStateSafe = !idPresent(originalTableId) || originalRestored;
      const recovered = noTableCleanupNeeded && originalStateSafe && residueFree;
      finalStatus = recovered ? "IMPORT_FAILED_RECOVERED" : "IMPORT_RECOVERY_REQUIRED";
      add("commit", finalStatus, {
        originalRestored,
        generatedTableDeleted: noTableCleanupNeeded,
        recognizedResidueFree: residueFree
      });
      if (recovered) {
        if (!clearJournal()) add("journal", "CLEAR_FAILED", { sessionMarker });
      } else {
        writeJournal("RECOVERY_REQUIRED", true);
      }
    }
    operationRunning = false;
    await autoCopy();
    console.log("XIAOAI_IMPORTER_DONE: " + finalStatus);
    return report();
  }

  async function run(payload) {
    if (manualReviewReloadRequired) {
      add("run", "BLOCKED", { reason: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW", writeRequestsMade: 0 });
      return report();
    }
    const summary = prepare(payload);
    if (summary.status !== "READY") {
      await autoCopy();
      console.log("XIAOAI_IMPORTER_DONE: " + finalStatus);
      return report();
    }
    return commit();
  }

  async function cleanupVerifiedImport() {
    if (manualReviewReloadRequired) {
      add("cleanup-verified-import", "BLOCKED", {
        reason: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW",
        destructiveRequestsMade: 0
      });
      return report();
    }
    if (operationRunning) {
      add("cleanup-verified-import", "BLOCKED", { reason: "OPERATION_RUNNING" });
      return report();
    }
    if (finalStatus !== "IMPORT_VERIFIED" || !importVerified || !generatedOwnershipProven ||
        !idPresent(originalTableId) || !idPresent(generatedTableId) || !idPresent(generatedSettingId)) {
      add("cleanup-verified-import", "BLOCKED", {
        reason: "VERIFIED_OWNED_IMPORT_REQUIRED",
        importVerified,
        generatedOwnershipProven,
        originalTableIdPresent: idPresent(originalTableId),
        generatedTableIdPresent: idPresent(generatedTableId),
        generatedSettingIdPresent: idPresent(generatedSettingId)
      });
      return report();
    }
    if (!writeJournal("VERIFIED_CLEANUP_RUNNING", true)) {
      add("cleanup-verified-import", "BLOCKED", {
        reason: "JOURNAL_WRITE_OR_VERIFY_FAILED",
        destructiveRequestsMade: 0
      });
      return report();
    }

    operationRunning = true;
    add("cleanup-verified-import", "STARTED", {
      verifiedCourseCount: preparedPayload.courses.length,
      generatedOwnershipProven: true
    });
    try {
      await restoreOriginalTable();
      await deleteGeneratedTable();
      await auditResidue();
    } catch (_) {
      add("cleanup-verified-import", "ERROR", {
        reason: "UNEXPECTED_ERROR",
        recoveryWillRemainAvailable: true
      });
    }

    const cleaned = originalRestored && generatedTableDeleted && residueFree;
    finalStatus = cleaned ? "IMPORT_VERIFIED_AND_CLEAN" : "IMPORT_RECOVERY_REQUIRED";
    add("cleanup-verified-import", finalStatus, {
      originalRestored,
      generatedTableDeleted,
      recognizedResidueFree: residueFree
    });
    if (cleaned) {
      if (!clearJournal()) add("journal", "CLEAR_FAILED", { sessionMarker });
    } else {
      writeJournal("RECOVERY_REQUIRED", true);
    }
    operationRunning = false;
    await autoCopy();
    console.log("XIAOAI_IMPORTER_CLEANUP_DONE: " + finalStatus);
    return report();
  }

  function hasPersistedMarker(course) {
    if (!course || typeof course.extend !== "string") return false;
    try {
      const marker = JSON.parse(course.extend).xiaoaiImporter;
      return marker && marker.transactionId === sessionMarker && marker.payloadHash === payloadHash;
    } catch (_) { return false; }
  }

  function isPreWriteJournal(journal) {
    return !!journal && journal.stage === "WRITE_PREFLIGHT_COMPLETE" &&
      journal.tableCreateStarted !== true && journal.tableOwnershipProvenInMemory !== true &&
      journal.switchRequestStarted !== true && journal.uploadNetworkStarted !== true &&
      !idPresent(journal.generatedTableId) && !idPresent(journal.generatedSettingId);
  }

  function isUnprovenCreateManualReviewJournal(journal) {
    return !!journal && journal.unfinished === true && journal.stage === "RECOVERY_REQUIRED" &&
      journal.contractVersion === 2 && journal.sessionMarker !== "XIUNKNOWN" &&
      journal.createdAt !== "unknown" && journal.recoveryRequired === true && journal.tableCreateStarted === true &&
      journal.tableOwnershipProvenInMemory !== true && journal.switchRequestStarted !== true &&
      journal.uploadNetworkStarted !== true && journal.importVerified !== true &&
      !idPresent(journal.generatedTableId) && !idPresent(journal.generatedSettingId) &&
      Array.isArray(journal.responseIds) && journal.responseIds.length === 0 &&
      Number.isInteger(journal.courseCount) && journal.courseCount > 0 &&
      Number.isInteger(journal.tableNameLength) && journal.tableNameLength > 0 &&
      typeof journal.payloadHash === "string" && /^[0-9a-f]{64}$/.test(journal.payloadHash) &&
      idPresent(journal.originalTableId);
  }

  function sameUnprovenCreateManualReviewJournal(left, right) {
    return isUnprovenCreateManualReviewJournal(left) && isUnprovenCreateManualReviewJournal(right) &&
      left.schemaVersion === right.schemaVersion && left.contractVersion === right.contractVersion &&
      left.sessionMarker === right.sessionMarker && left.createdAt === right.createdAt &&
      left.updatedAt === right.updatedAt && left.stage === right.stage && left.payloadHash === right.payloadHash &&
      String(left.originalTableId) === String(right.originalTableId) && left.courseCount === right.courseCount &&
      left.tableNameLength === right.tableNameLength;
  }

  function isAbsentOwnedTableManualReviewJournal(journal) {
    return !!journal && journal.unfinished === true && journal.stage === "UPLOAD_NETWORK_STARTED" &&
      journal.contractVersion === 2 && journal.sessionMarker !== "XIUNKNOWN" && journal.createdAt !== "unknown" &&
      journal.tableCreateStarted === true && journal.tableOwnershipProvenInMemory === true &&
      journal.switchRequestStarted === true && journal.uploadNetworkStarted === true && journal.importVerified !== true &&
      idPresent(journal.originalTableId) && idPresent(journal.generatedTableId) && idPresent(journal.generatedSettingId) &&
      Array.isArray(journal.responseIds) && journal.responseIds.length === 0 &&
      Number.isInteger(journal.courseCount) && journal.courseCount > 0 &&
      Number.isInteger(journal.tableNameLength) && journal.tableNameLength > 0 &&
      typeof journal.payloadHash === "string" && /^[0-9a-f]{64}$/.test(journal.payloadHash);
  }

  function sameAbsentOwnedTableManualReviewJournal(left, right) {
    return isAbsentOwnedTableManualReviewJournal(left) && isAbsentOwnedTableManualReviewJournal(right) &&
      left.schemaVersion === right.schemaVersion && left.contractVersion === right.contractVersion &&
      left.sessionMarker === right.sessionMarker && left.createdAt === right.createdAt &&
      left.updatedAt === right.updatedAt && left.stage === right.stage && left.payloadHash === right.payloadHash &&
      String(left.originalTableId) === String(right.originalTableId) &&
      String(left.generatedTableId) === String(right.generatedTableId) &&
      String(left.generatedSettingId) === String(right.generatedSettingId) &&
      left.courseCount === right.courseCount && left.tableNameLength === right.tableNameLength;
  }

  function manualReviewAuditSummary(initialCurrent, finalCurrent, listed, scan, markerResidueCount, returnedIdResidueCount) {
    return {
      originalCurrentStable: !!(initialCurrent && initialCurrent.stable && finalCurrent && finalCurrent.stable),
      current: finalCurrent ? currentSummary(finalCurrent) : null,
      tableListApiSuccess: !!(listed && apiSuccess(listed.result)),
      tableCount: listed ? listed.tables.length : 0,
      tablesRead: scan ? scan.records.length : 0,
      readFailures: scan ? scan.failures : 1,
      allTableReadsComplete: !!(scan && scan.complete),
      markerResidueCount,
      returnedIdResidueCount,
      unknownTableOwnershipProven: false
    };
  }

  async function performUnprovenCreateRecoveryAudit() {
    if (location.origin !== EXPECTED_ORIGIN) {
      add("manual-create-recovery-audit", "BLOCKED", { reason: "ORIGIN_MISMATCH" });
      return { ready: false, reason: "ORIGIN_MISMATCH" };
    }
    if (!isUnprovenCreateManualReviewJournal(journalState) || !idPresent(originalTableId)) {
      add("manual-create-recovery-audit", "BLOCKED", {
        reason: "NOT_UNPROVEN_CREATE_ONLY_JOURNAL",
        localJournalOnly: true,
        automaticDeleteRequestsMade: 0
      });
      return { ready: false, reason: "NOT_UNPROVEN_CREATE_ONLY_JOURNAL" };
    }

    const initialCurrent = await waitForCurrent(originalTableId);
    let listed = null;
    let scan = null;
    let markerResidueCount = 0;
    let returnedIdResidueCount = 0;
    try {
      listed = await listTables();
      scan = await readEveryTable(listed);
      const returnedIds = new Set(responseIds.map(String));
      scan.records.forEach(function (record) {
        record.courses.forEach(function (course) {
          if (hasPersistedMarker(course)) markerResidueCount += 1;
          if (course && idPresent(course.id) && returnedIds.has(String(course.id))) returnedIdResidueCount += 1;
        });
      });
    } catch (_) {}

    const sourceIsCurrent = !!(listed && currentState(listed).valid &&
      String(currentState(listed).currentId) === String(originalTableId));
    const finalCurrent = await waitForCurrent(originalTableId);
    const summary = manualReviewAuditSummary(
      initialCurrent,
      finalCurrent,
      listed,
      scan,
      markerResidueCount,
      returnedIdResidueCount
    );
    const ready = initialCurrent.stable && finalCurrent.stable && sourceIsCurrent && !!(scan && scan.complete) &&
      markerResidueCount === 0 && returnedIdResidueCount === 0;
    add("manual-create-recovery-audit", ready ? "READY" : "BLOCKED", Object.assign({}, summary, {
      reason: ready ? undefined : "READ_ONLY_SAFETY_CHECK_FAILED"
    }));
    return Object.assign({ ready, reason: ready ? undefined : "READ_ONLY_SAFETY_CHECK_FAILED" }, summary);
  }

  async function auditUnprovenCreateRecovery() {
    if (operationRunning) {
      add("manual-create-recovery-audit", "BLOCKED", { reason: "OPERATION_RUNNING" });
      return { ready: false, reason: "OPERATION_RUNNING" };
    }
    return performUnprovenCreateRecoveryAudit();
  }

  async function acknowledgeUnprovenCreateRecovery(options) {
    if (manualReviewReloadRequired) {
      add("manual-create-recovery-acknowledgement", "BLOCKED", {
        reason: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW",
        localJournalOnly: true,
        automaticDeleteRequestsMade: 0
      });
      return report();
    }
    if (operationRunning) {
      add("manual-create-recovery-acknowledgement", "BLOCKED", {
        reason: "OPERATION_RUNNING",
        localJournalOnly: true,
        automaticDeleteRequestsMade: 0
      });
      return report();
    }
    if (!options || options.confirmation !== MANUAL_UNPROVEN_CREATE_CONFIRMATION) {
      add("manual-create-recovery-acknowledgement", "BLOCKED", {
        reason: "EXPLICIT_CONFIRMATION_REQUIRED",
        localJournalOnly: true,
        automaticDeleteRequestsMade: 0
      });
      return report();
    }

    operationRunning = true;
    let shouldCopy = false;
    try {
      const auditedJournal = journalState;
      const audit = await performUnprovenCreateRecoveryAudit();
      if (!audit.ready) {
        add("manual-create-recovery-acknowledgement", "BLOCKED", {
          reason: audit.reason || "READ_ONLY_SAFETY_CHECK_FAILED",
          localJournalOnly: true,
          automaticDeleteRequestsMade: 0
        });
      } else if (!sameUnprovenCreateManualReviewJournal(auditedJournal, readJournal())) {
        add("manual-create-recovery-acknowledgement", "BLOCKED", {
          reason: "JOURNAL_CHANGED_DURING_AUDIT",
          localJournalOnly: true,
          automaticDeleteRequestsMade: 0
        });
      } else if (!clearJournal()) {
        finalStatus = "IMPORT_RECOVERY_FROZEN";
        add("manual-create-recovery-acknowledgement", "BLOCKED", {
          reason: "JOURNAL_CLEAR_FAILED",
          localJournalOnly: true,
          automaticDeleteRequestsMade: 0
        });
        shouldCopy = true;
      } else {
        manualReviewAcknowledged = true;
        manualReviewReloadRequired = true;
        finalStatus = "MANUAL_REVIEW_ACKNOWLEDGED";
        add("manual-create-recovery-acknowledgement", "MANUAL_REVIEW_ACKNOWLEDGED", {
          localJournalOnly: true,
          automaticDeleteRequestsMade: 0,
          originalCurrentStable: true,
          allTableReadsComplete: true,
          markerResidueCount: 0,
          returnedIdResidueCount: 0,
          unknownTableOwnershipProven: false,
          reloadRequired: true
        });
        shouldCopy = true;
      }
    } catch (_) {
      finalStatus = "IMPORT_RECOVERY_FROZEN";
      add("manual-create-recovery-acknowledgement", "BLOCKED", {
        reason: "UNEXPECTED_ERROR",
        localJournalOnly: true,
        automaticDeleteRequestsMade: 0
      });
      shouldCopy = true;
    } finally {
      operationRunning = false;
    }
    if (shouldCopy) {
      await autoCopy();
      console.log("XIAOAI_IMPORTER_MANUAL_REVIEW_DONE: " + finalStatus);
    }
    return report();
  }

  async function performAbsentOwnedTableRecoveryAudit() {
    if (location.origin !== EXPECTED_ORIGIN) {
      add("manual-absent-owned-table-audit", "BLOCKED", { reason: "ORIGIN_MISMATCH" });
      return { ready: false, reason: "ORIGIN_MISMATCH" };
    }
    if (!isAbsentOwnedTableManualReviewJournal(journalState)) {
      add("manual-absent-owned-table-audit", "BLOCKED", {
        reason: "NOT_OWNED_UPLOAD_START_JOURNAL",
        localJournalOnly: true,
        automaticWriteRequestsMade: 0
      });
      return { ready: false, reason: "NOT_OWNED_UPLOAD_START_JOURNAL" };
    }

    const initialCurrent = await waitForCurrent(null);
    let listed = null;
    let scan = null;
    let markerResidueCount = 0;
    let returnedIdResidueCount = 0;
    try {
      listed = await listTables();
      scan = await readEveryTable(listed);
      const returnedIds = new Set(responseIds.map(String));
      scan.records.forEach(function (record) {
        record.courses.forEach(function (course) {
          if (hasPersistedMarker(course)) markerResidueCount += 1;
          if (course && idPresent(course.id) && returnedIds.has(String(course.id))) returnedIdResidueCount += 1;
        });
      });
    } catch (_) {}

    const listedState = listed ? currentState(listed) : { valid: false, currentId: null };
    const originalTableMatchCount = listed ? listed.tables.filter(function (table) {
      return String(tableIdOf(table)) === String(originalTableId);
    }).length : 0;
    const generatedTablePresent = !!(listed && listed.tables.some(function (table) {
      return String(tableIdOf(table)) === String(generatedTableId);
    }));
    const finalCurrent = await waitForCurrent(null);
    const currentStable = initialCurrent.stable && finalCurrent.stable && listedState.valid &&
      String(initialCurrent.currentId) === String(finalCurrent.currentId) &&
      String(listedState.currentId) === String(finalCurrent.currentId);
    const summary = {
      currentStable,
      current: currentSummary(finalCurrent),
      tableListApiSuccess: !!(listed && apiSuccess(listed.result)),
      tableCount: listed ? listed.tables.length : 0,
      tablesRead: scan ? scan.records.length : 0,
      readFailures: scan ? scan.failures : 1,
      allTableReadsComplete: !!(scan && scan.complete),
      originalTableMatchCount,
      generatedTablePresent,
      markerResidueCount,
      returnedIdResidueCount,
      recordedOriginalCurrent: !!(currentStable && String(finalCurrent.currentId) === String(originalTableId))
    };
    const ready = currentStable && !!(listed && apiSuccess(listed.result)) && !!(scan && scan.complete) &&
      originalTableMatchCount === 1 && !generatedTablePresent && markerResidueCount === 0 && returnedIdResidueCount === 0;
    add("manual-absent-owned-table-audit", ready ? "READY" : "BLOCKED", Object.assign({}, summary, {
      reason: ready ? undefined : "READ_ONLY_SAFETY_CHECK_FAILED"
    }));
    return Object.assign({ ready, reason: ready ? undefined : "READ_ONLY_SAFETY_CHECK_FAILED" }, summary);
  }

  async function auditAbsentOwnedTableRecovery() {
    if (operationRunning) {
      add("manual-absent-owned-table-audit", "BLOCKED", { reason: "OPERATION_RUNNING" });
      return { ready: false, reason: "OPERATION_RUNNING" };
    }
    return performAbsentOwnedTableRecoveryAudit();
  }

  async function acknowledgeAbsentOwnedTableRecovery(options) {
    if (manualReviewReloadRequired) {
      add("manual-absent-owned-table-acknowledgement", "BLOCKED", {
        reason: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW",
        localJournalOnly: true,
        automaticWriteRequestsMade: 0
      });
      return report();
    }
    if (operationRunning) {
      add("manual-absent-owned-table-acknowledgement", "BLOCKED", {
        reason: "OPERATION_RUNNING",
        localJournalOnly: true,
        automaticWriteRequestsMade: 0
      });
      return report();
    }
    if (!options || options.confirmation !== MANUAL_ABSENT_OWNED_TABLE_CONFIRMATION) {
      add("manual-absent-owned-table-acknowledgement", "BLOCKED", {
        reason: "EXPLICIT_CONFIRMATION_REQUIRED",
        localJournalOnly: true,
        automaticWriteRequestsMade: 0
      });
      return report();
    }

    operationRunning = true;
    let shouldCopy = false;
    try {
      const auditedJournal = journalState;
      const audit = await performAbsentOwnedTableRecoveryAudit();
      if (!audit.ready) {
        add("manual-absent-owned-table-acknowledgement", "BLOCKED", {
          reason: audit.reason || "READ_ONLY_SAFETY_CHECK_FAILED",
          localJournalOnly: true,
          automaticWriteRequestsMade: 0
        });
      } else if (!sameAbsentOwnedTableManualReviewJournal(auditedJournal, readJournal())) {
        add("manual-absent-owned-table-acknowledgement", "BLOCKED", {
          reason: "JOURNAL_CHANGED_DURING_AUDIT",
          localJournalOnly: true,
          automaticWriteRequestsMade: 0
        });
      } else if (!clearJournal()) {
        finalStatus = "IMPORT_RECOVERY_FROZEN";
        add("manual-absent-owned-table-acknowledgement", "BLOCKED", {
          reason: "JOURNAL_CLEAR_FAILED",
          localJournalOnly: true,
          automaticWriteRequestsMade: 0
        });
        shouldCopy = true;
      } else {
        manualReviewAcknowledged = true;
        manualReviewReloadRequired = true;
        finalStatus = "MANUAL_ABSENT_OWNED_TABLE_ACKNOWLEDGED";
        add("manual-absent-owned-table-acknowledgement", finalStatus, {
          localJournalOnly: true,
          automaticWriteRequestsMade: 0,
          currentStable: true,
          currentSelectionAccepted: true,
          generatedTablePresent: false,
          allTableReadsComplete: true,
          markerResidueCount: 0,
          returnedIdResidueCount: 0,
          reloadRequired: true
        });
        shouldCopy = true;
      }
    } catch (_) {
      finalStatus = "IMPORT_RECOVERY_FROZEN";
      add("manual-absent-owned-table-acknowledgement", "BLOCKED", {
        reason: "UNEXPECTED_ERROR",
        localJournalOnly: true,
        automaticWriteRequestsMade: 0
      });
      shouldCopy = true;
    } finally {
      operationRunning = false;
    }
    if (shouldCopy) {
      await autoCopy();
      console.log("XIAOAI_IMPORTER_MANUAL_REVIEW_DONE: " + finalStatus);
    }
    return report();
  }

  async function scanPersistedRecoveryResidue() {
    let listed;
    try { listed = await listTables(); } catch (_) {
      return {
        complete: false,
        tableCount: 0,
        tablesRead: 0,
        readFailures: 1,
        generatedTablePresent: false,
        markerResidueCount: 0,
        returnedIdResidueCount: 0
      };
    }
    const scan = await readEveryTable(listed);
    const returnedIds = new Set(responseIds.map(String));
    let markerResidueCount = 0;
    let returnedIdResidueCount = 0;
    scan.records.forEach(function (record) {
      record.courses.forEach(function (course) {
        if (hasPersistedMarker(course)) markerResidueCount += 1;
        if (course && idPresent(course.id) && returnedIds.has(String(course.id))) returnedIdResidueCount += 1;
      });
    });
    return {
      complete: scan.complete,
      tableCount: listed.tables.length,
      tablesRead: scan.records.length,
      readFailures: scan.failures,
      generatedTablePresent: listed.tables.some(function (table) {
        return String(tableIdOf(table)) === String(generatedTableId);
      }),
      markerResidueCount,
      returnedIdResidueCount
    };
  }

  async function auditPersistedRecoveryResidue() {
    let cleanReads = 0;
    let last = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await pause(POLL_INTERVAL_MS);
      last = await scanPersistedRecoveryResidue();
      attempts = attempt;
      const clean = last.complete && !last.generatedTablePresent && last.markerResidueCount === 0 &&
        last.returnedIdResidueCount === 0;
      cleanReads = clean ? cleanReads + 1 : 0;
      if (cleanReads >= STABLE_READS) break;
    }
    last = last || {
      complete: false,
      tableCount: 0,
      tablesRead: 0,
      readFailures: 1,
      generatedTablePresent: false,
      markerResidueCount: 0,
      returnedIdResidueCount: 0
    };
    cleanupScanComplete = last.complete;
    unresolvedFingerprintResidueCount = 0;
    residueFree = cleanReads >= STABLE_READS;
    add("recover-persisted-residue-audit", residueFree ? "NO_RECOGNIZED_RESIDUE" : "ATTENTION_REQUIRED", {
      attempts,
      stableCleanReads: cleanReads,
      tableCount: last.tableCount,
      tablesRead: last.tablesRead,
      readFailures: last.readFailures,
      generatedTablePresent: last.generatedTablePresent,
      markerResidueCount: last.markerResidueCount,
      returnedIdResidueCount: last.returnedIdResidueCount
    });
    return residueFree;
  }

  async function recoverPersistedJournal() {
    if (!journalState) {
      add("recover-persisted", "FROZEN", { reason: "JOURNAL_UNAVAILABLE", deleteRequestsMade: 0 });
      return false;
    }
    if (isPreWriteJournal(journalState)) {
      const cleared = clearJournal();
      add("recover-persisted", cleared ? "PRE_WRITE_JOURNAL_CLEARED" : "FROZEN", {
        reason: cleared ? "NO_XIAOMI_WRITE_REQUEST_WAS_STARTED" : "JOURNAL_CLEAR_FAILED",
        deleteRequestsMade: 0
      });
      return cleared;
    }
    if (!idPresent(originalTableId) || !journalState.tableCreateStarted ||
        !journalState.tableOwnershipProvenInMemory || !idPresent(generatedTableId)) {
      add("recover-persisted", "FROZEN", {
        reason: "OWNERSHIP_IDS_INCOMPLETE",
        originalTableIdPresent: idPresent(originalTableId),
        generatedTableIdPresent: idPresent(generatedTableId),
        createResponseOwnershipPersisted: journalState.tableOwnershipProvenInMemory === true,
        deleteRequestsMade: 0
      });
      return false;
    }
    if (journalState.stage === "IMPORT_VERIFIED") {
      const cleared = clearJournal();
      persistedVerifiedJournalCleared = cleared;
      add("recover-persisted", cleared ? "VERIFIED_JOURNAL_CLEARED" : "FROZEN", { rollbackPerformed: false });
      return cleared;
    }
    let listed;
    try { listed = await listTables(); } catch (_) {
      add("recover-persisted", "FROZEN", { reason: "TABLE_LIST_UNAVAILABLE", deleteRequestsMade: 0 });
      return false;
    }
    generatedOwnershipProven = true;
    const generated = listed.tables.filter(function (table) {
      return String(tableIdOf(table)) === String(generatedTableId);
    });
    const original = listed.tables.filter(function (table) {
      return String(tableIdOf(table)) === String(originalTableId);
    });
    if (generated.length === 0 && original.length === 1) {
      const originalCurrent = await waitForCurrent(originalTableId);
      if (!originalCurrent.stable) {
        add("recover-persisted", "FROZEN", {
          reason: "ORIGINAL_CURRENT_NOT_VERIFIED",
          originalCurrent: currentSummary(originalCurrent),
          deleteRequestsMade: 0
        });
        return false;
      }
      originalRestored = true;
      generatedTableDeleted = true;
      const residueAudited = await auditPersistedRecoveryResidue();
      const cleared = residueAudited && clearJournal();
      add("recover-persisted", cleared ? "ALREADY_CLEAN" : "FROZEN", {
        generatedTablePresent: false,
        originalRestored,
        residueFree
      });
      return cleared;
    }
    if (generated.length !== 1 || original.length !== 1) {
      add("recover-persisted", "FROZEN", { reason: "OWNERSHIP_CHANGED", deleteRequestsMade: 0 });
      return false;
    }
    const listedSettingId = generated[0].setting && generated[0].setting.id;
    if (!idPresent(generatedSettingId)) {
      if (!idPresent(listedSettingId)) {
        add("recover-persisted", "FROZEN", { reason: "SETTING_ID_UNAVAILABLE", deleteRequestsMade: 0 });
        return false;
      }
      generatedSettingId = listedSettingId;
      if (!writeJournal("RECOVERY_SETTING_ID_REDISCOVERED", true)) {
        add("recover-persisted", "FROZEN", {
          reason: "JOURNAL_STAGE_WRITE_FAILED",
          deleteRequestsMade: 0
        });
        return false;
      }
      add("recover-persisted-setting-id", "REDISCOVERED", { generatedSettingIdPresent: true });
    } else if (String(listedSettingId) !== String(generatedSettingId)) {
      add("recover-persisted", "FROZEN", { reason: "OWNERSHIP_CHANGED", deleteRequestsMade: 0 });
      return false;
    }
    let detail;
    try { detail = await tableDetail(generatedTableId); } catch (_) {
      add("recover-persisted", "FROZEN", { reason: "DETAIL_UNAVAILABLE", deleteRequestsMade: 0 });
      return false;
    }
    const courses = detail.data && Array.isArray(detail.data.courses) ? detail.data.courses : [];
    if (!apiSuccess(detail.result) || !courses.every(hasPersistedMarker)) {
      add("recover-persisted", "FROZEN", {
        reason: "TABLE_CONTENT_OWNERSHIP_UNPROVEN",
        courseCount: courses.length,
        deleteRequestsMade: 0
      });
      return false;
    }
    const preDeleteScan = await scanPersistedRecoveryResidue();
    cleanupScanComplete = preDeleteScan.complete;
    if (!preDeleteScan.complete) {
      destructiveRecoveryBlocked = true;
      add("recover-persisted", "FROZEN", {
        reason: "ALL_TABLE_SCAN_INCOMPLETE_DELETIONS_FROZEN",
        tableCount: preDeleteScan.tableCount,
        tablesRead: preDeleteScan.tablesRead,
        readFailures: preDeleteScan.readFailures,
        deleteRequestsMade: 0
      });
      return false;
    }
    const current = await waitForCurrent(null);
    if (!current.stable) {
      add("recover-persisted", "FROZEN", { reason: "CURRENT_TABLE_UNSTABLE", deleteRequestsMade: 0 });
      return false;
    }
    if (String(current.currentId) === String(generatedTableId)) {
      originalRestored = await switchTable(generatedTableId, originalTableId, "recover-persisted-restore");
      if (!originalRestored) return false;
    } else if (String(current.currentId) === String(originalTableId)) {
      originalRestored = true;
    } else {
      add("recover-persisted", "FROZEN", { reason: "EXTERNAL_CURRENT_TABLE", deleteRequestsMade: 0 });
      return false;
    }
    let deleted = null;
    try {
      deleted = await request("DELETE", "/course-multi-auth/table", {
        ctId: generatedTableId,
        sId: generatedSettingId,
        sourceName: SOURCE_NAME
      });
    } catch (_) {}
    let after;
    try { after = await listTables(); } catch (_) {
      add("recover-persisted", "FROZEN", {
        reason: "POST_DELETE_TABLE_LIST_UNAVAILABLE",
        deleteRequestsMade: 1
      });
      return false;
    }
    const absent = apiSuccess(after.result) && !after.tables.some(function (table) {
      return String(tableIdOf(table)) === String(generatedTableId);
    });
    generatedTableDeleted = absent;
    const residueAudited = absent && await auditPersistedRecoveryResidue();
    const cleared = residueAudited && clearJournal();
    add("recover-persisted", cleared ? "RECOVERED" : "FROZEN", {
      request: responseSummary(deleted),
      generatedTableRemoved: absent,
      originalRestored,
      residueFree
    });
    return cleared;
  }

  async function recover() {
    if (manualReviewReloadRequired) {
      add("recover", "BLOCKED", { reason: "RELOAD_REQUIRED_AFTER_MANUAL_REVIEW", writeRequestsMade: 0 });
      return report();
    }
    if (operationRunning) {
      add("recover", "BLOCKED", { reason: "OPERATION_RUNNING" });
      return report();
    }
    if (journalBlocked) {
      operationRunning = true;
      persistedVerifiedJournalCleared = false;
      let recovered = false;
      try {
        recovered = await recoverPersistedJournal();
      } catch (_) {
        add("recover-persisted", "FROZEN", { reason: "UNEXPECTED_ERROR", deleteRequestsMade: 0 });
      } finally {
        operationRunning = false;
      }
      finalStatus = recovered ? (persistedVerifiedJournalCleared ? "IMPORT_VERIFIED" : "IMPORT_FAILED_RECOVERED") :
        "IMPORT_RECOVERY_FROZEN";
      await autoCopy();
      console.log("XIAOAI_IMPORTER_RECOVER_DONE: " + finalStatus);
      return report();
    }
    if (!commitStarted || finalStatus !== "IMPORT_RECOVERY_REQUIRED") {
      add("recover", "NOT_REQUIRED", { finalStatus });
      await autoCopy();
      console.log("XIAOAI_IMPORTER_RECOVER_DONE: " + finalStatus);
      return report();
    }
    operationRunning = true;
    recoveryAttempts += 1;
    destructiveRecoveryBlocked = false;
    cleanupScanComplete = null;
    unresolvedFingerprintResidueCount = 0;
    writeJournal("RECOVERY_RETRY_RUNNING", true);
    add("recover", "STARTED", { recoveryAttempt: recoveryAttempts });
    await recoverFailure();
    const noTableCleanupNeeded = !tableCreateStarted || generatedTableDeleted;
    const originalStateSafe = !idPresent(originalTableId) || originalRestored;
    const recovered = noTableCleanupNeeded && originalStateSafe && residueFree;
    finalStatus = recovered ? "IMPORT_FAILED_RECOVERED" : "IMPORT_RECOVERY_REQUIRED";
    add("recover", finalStatus, {
      recoveryAttempt: recoveryAttempts,
      originalRestored,
      generatedTableDeleted: noTableCleanupNeeded,
      recognizedResidueFree: residueFree
    });
    if (recovered) clearJournal();
    else writeJournal("RECOVERY_REQUIRED", true);
    operationRunning = false;
    await autoCopy();
    console.log("XIAOAI_IMPORTER_RECOVER_DONE: " + finalStatus);
    return report();
  }

  const importerApi = {
    prepare,
    commit,
    run,
    cleanupVerifiedImport,
    recover,
    auditUnprovenCreateRecovery,
    acknowledgeUnprovenCreateRecovery,
    auditAbsentOwnedTableRecovery,
    acknowledgeAbsentOwnedTableRecovery,
    report,
    copy
  };
  Object.defineProperty(importerApi, "__recordInstallAttempt", {
    enumerable: false,
    value: function () { add("installer", "INSTALLED_ALREADY", { existingOneShotLockRetained: true }); }
  });
  window[GLOBAL_NAME] = Object.freeze(importerApi);
  if (journalBlocked) {
    add("installer", "JOURNAL_INCOMPLETE", {
      sessionMarker,
      automaticRecoveryStarted: true,
      newImportBlocked: true
    });
    console.log("XIAOAI_IMPORTER_JOURNAL_INCOMPLETE: automatic recovery started");
    Promise.resolve().then(recover);
  } else {
    console.log("[XiaoAi schedule importer] Installed. No request was made.");
    console.log("Use prepare(payload) to validate without requests, then commit(); or run(payload) for both steps.");
  }
  return report();
})();
