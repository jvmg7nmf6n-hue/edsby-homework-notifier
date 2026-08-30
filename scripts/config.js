// Runtime configuration. Personal identifiers and credentials are deliberately
// environment-only so the code can safely live in a public repository.

function required(name) {
  const value = process.env[name]?.trim();
  if (value) return value;
  throw new Error(`Missing required environment variable: ${name}`);
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function integer(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function csv(name) {
  return required(name).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function jsonArray(name, fallback = []) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("must be a JSON array");
    return value;
  } catch (error) {
    throw new Error(`${name} must be a valid JSON array: ${error.message}`);
  }
}

let childrenCache;
let edsbyPrivateCache;
function edsbyPrivate() {
  if (edsbyPrivateCache) return edsbyPrivateCache;
  const raw = process.env.EDSBY_CONFIG_JSON?.trim();
  if (!raw) return (edsbyPrivateCache = {});
  try {
    return (edsbyPrivateCache = JSON.parse(raw));
  } catch (error) {
    throw new Error(`EDSBY_CONFIG_JSON must be valid JSON: ${error.message}`);
  }
}

function children() {
  if (childrenCache) return childrenCache;
  let parsed;
  try {
    parsed = edsbyPrivate().children || JSON.parse(required("EDSBY_CHILDREN_JSON"));
  } catch (error) {
    throw new Error(`EDSBY_CHILDREN_JSON must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("EDSBY_CHILDREN_JSON must be a non-empty JSON array");
  }
  childrenCache = parsed.map((child, index) => {
    for (const field of ["id", "name", "grade", "dashboardUrl"]) {
      if (!String(child?.[field] || "").trim()) {
        throw new Error(`EDSBY_CHILDREN_JSON[${index}].${field} is required`);
      }
    }
    return {
      id: String(child.id),
      name: String(child.name),
      grade: String(child.grade),
      dashboardUrl: String(child.dashboardUrl),
    };
  });
  return childrenCache;
}

export function isDryRun() {
  return process.argv.includes("--dry-run") || bool("DRY_RUN", false);
}

export const config = {
  edsby: {
    get enabled() {
      return bool("EDSBY_ENABLED", true);
    },
    get baseUrl() {
      const value = process.env.EDSBY_BASE_URL?.trim() || edsbyPrivate().baseUrl;
      if (value) return value;
      if (this.enabled) return required("EDSBY_BASE_URL");
      return "";
    },
    get parentHomeUrl() {
      return process.env.EDSBY_PARENT_HOME_URL?.trim() || edsbyPrivate().parentHomeUrl || this.baseUrl || children()[0].dashboardUrl;
    },
    get children() {
      return children();
    },
    get email() {
      return required("EDSBY_EMAIL");
    },
    get password() {
      return required("EDSBY_PASSWORD");
    },
  },
  gmail: {
    get enabled() {
      return bool("GMAIL_ENABLED", false);
    },
    get accountEmail() {
      return required("GMAIL_ACCOUNT_EMAIL");
    },
    get clientId() {
      return required("GMAIL_CLIENT_ID");
    },
    get clientSecret() {
      return required("GMAIL_CLIENT_SECRET");
    },
    get refreshToken() {
      return required("GMAIL_REFRESH_TOKEN");
    },
    get query() {
      return required("GMAIL_QUERY");
    },
    get schoolDomains() {
      return csv("GMAIL_SCHOOL_DOMAINS");
    },
    get childId() {
      return process.env.GMAIL_CHILD_ID?.trim() || children()[0].id;
    },
    get maxMessages() {
      return integer("GMAIL_MAX_MESSAGES", 25, { min: 1, max: 50 });
    },
  },
  get schoolCourses() {
    return jsonArray("SCHOOL_COURSES_JSON").map((entry, index) => {
      if (!String(entry?.course || "").trim() || !String(entry?.teacher || "").trim()) {
        throw new Error(`SCHOOL_COURSES_JSON[${index}] requires course and teacher`);
      }
      return {
        course: String(entry.course).trim(),
        teacher: String(entry.teacher).trim(),
        keywords: Array.isArray(entry.keywords) ? entry.keywords.map(String) : [],
      };
    });
  },
  get runMode() {
    const mode = process.env.RUN_MODE?.trim().toLowerCase() || "digest";
    if (!["digest", "realtime"].includes(mode)) throw new Error("RUN_MODE must be digest or realtime");
    return mode;
  },
  ntfy: {
    get server() {
      return process.env.NTFY_SERVER?.trim() || "https://ntfy.sh";
    },
    get topic() {
      if (isDryRun()) return process.env.NTFY_TOPIC?.trim() || "dry-run-topic";
      return required("NTFY_TOPIC");
    },
    get alertsTopic() {
      return process.env.NTFY_ALERTS_TOPIC?.trim() || this.topic;
    },
  },
  dashboardHistoryDays: integer("DASHBOARD_HISTORY_DAYS", 14, { min: 1, max: 90 }),
  maxShowOlderClicks: integer("MAX_SHOW_OLDER_CLICKS", 20, { min: 0, max: 60 }),
  lookbackBufferDays: integer("LOOKBACK_BUFFER_DAYS", 3, { min: 0, max: 14 }),
};
