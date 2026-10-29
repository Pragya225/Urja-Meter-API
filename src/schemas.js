/** JSON Schemas: used for request validation, response serialisation AND to generate openapi.json, so docs can't drift from behaviour. */
const nullable = (s) => ({ ...s, nullable: true });
const str = (example, description) =>
  nullable({ type: "string", example, ...(description && { description }) });

export const meterIdParam = {
  type: "object",
  required: ["meterId"],
  properties: {
    meterId: {
      type: "string",
      pattern: "^[A-Za-z0-9_-]{1,32}$",
      description: "Portal meter id, e.g. J100002",
      example: "J100002",
    },
  },
};

const location = nullable({
  type: "object",
  properties: {
    latitude: { type: "number", example: 26.8402 },
    longitude: { type: "number", example: 75.7146 },
  },
});

export const meterSummary = {
  type: "object",
  properties: {
    meterId: { type: "string", example: "J100002" },
    serialNo: str("AL28136"),
    make: str("L&T"),
    phaseType: str("single", "single | three"),
    installStatus: str("Installed", "Installed | Faulty | Decommissioned"),
    installationType: str("CT Operated", "CT Operated | Whole Current"),
    build: str(
      "legacy",
      'Portal "build" tag (legacy | v2). Meaning is undocumented by the portal.',
    ),
    dtCode: str("DT-003", "Distribution transformer the meter hangs off"),
    location,
    distanceKm: {
      type: "number",
      description: "Only present for ?lat&lng searches",
    },
  },
};

const levelNode = nullable({
  type: "object",
  properties: {
    name: str("Vaishali DT 3"),
    code: str(
      "DT-003",
      "null when the portal omitted it and it could not be repaired",
    ),
  },
});

export const hierarchy = {
  type: "object",
  description:
    "Where the meter sits in the network, top (zone) to bottom (distribution transformer). Codes are only unique within their parent.",
  properties: Object.fromEntries(
    [
      "zone",
      "circle",
      "division",
      "subdivision",
      "substation",
      "feeder",
      "dt",
    ].map((k) => [k, levelNode]),
  ),
};

export const meterDetail = {
  type: "object",
  properties: {
    ...meterSummary.properties,
    hierarchy,
    quality: {
      type: "object",
      description:
        "Data-quality flags for this meter, e.g. hierarchy_code_repaired:circle, dt_name_mismatch",
      properties: { flags: { type: "array", items: { type: "string" } } },
    },
    source: {
      type: "string",
      enum: ["export", "live"],
      description:
        "export = bulk snapshot; live = fetched from the portal for this request",
    },
    extraParameters: {
      type: "object",
      additionalProperties: true,
      description:
        "Nameplate parameters we do not model explicitly (live source only)",
    },
    warnings: { type: "array", items: { type: "string" } },
  },
};

export const meterList = {
  type: "object",
  properties: {
    items: { type: "array", items: meterSummary },
    total: { type: "integer", example: 403 },
    page: { type: "integer", example: 1 },
    pageSize: { type: "integer", example: 20 },
    source: { type: "string", enum: ["export", "live"] },
  },
};

export const meterListQuery = {
  type: "object",
  properties: {
    q: {
      type: "string",
      maxLength: 64,
      description: "Substring of meter id or serial number (case-insensitive)",
    },
    status: {
      type: "string",
      description: "Installed | Faulty | Decommissioned",
    },
    make: {
      type: "string",
      description: "HPL | Genus | Secure | Allied | L&T",
    },
    phase: { type: "string", description: "single | three" },
    build: { type: "string", description: "legacy | v2" },
    installationType: {
      type: "string",
      description: "CT Operated | Whole Current",
    },
    dtCode: { type: "string", description: "e.g. DT-003" },
    feeder: { type: "string", description: "Feeder code, e.g. F-003" },
    zone: { type: "string", description: "Zone code, e.g. Z-03" },
    lat: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "With lng: return meters within radiusKm, nearest first",
    },
    lng: { type: "number", minimum: -180, maximum: 180 },
    radiusKm: { type: "number", minimum: 0.001, maximum: 200, default: 5 },
    page: { type: "integer", minimum: 1, default: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
};

export const consumption = {
  type: "object",
  properties: {
    meterId: { type: "string" },
    readings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: {
            type: "string",
            format: "date-time",
            example: "2026-06-23T23:30:00+05:30",
          },
          kwh: {
            type: "number",
            description: "Cumulative active-energy register (kWh)",
          },
          kvah: nullable({
            type: "number",
            description: "Cumulative apparent-energy register (kVAh)",
          }),
          voltageR: nullable({
            type: "number",
            description: "R-phase voltage (V)",
          }),
          intervalKwh: nullable({
            type: "number",
            description:
              "Energy used since the previous reading; null for the first reading or after a counter reset",
          }),
        },
      },
    },
    summary: {
      type: "object",
      properties: {
        count: { type: "integer" },
        intervalMinutes: nullable({
          type: "number",
          description:
            "Typical gap between readings in minutes (30 = half-hourly, 1440 = daily). Differs per meter.",
        }),
        from: nullable({ type: "string", format: "date-time" }),
        to: nullable({ type: "string", format: "date-time" }),
        totalKwh: nullable({ type: "number" }),
        totalKvah: nullable({ type: "number" }),
        powerFactor: nullable({
          type: "number",
          description: "totalKwh / totalKvah",
        }),
        voltageR: nullable({
          type: "object",
          properties: {
            min: { type: "number" },
            max: { type: "number" },
            avg: { type: "number" },
          },
        }),
        counterResets: {
          type: "integer",
          description: "Times the cumulative register went backwards",
        },
      },
    },
    skippedRows: {
      type: "integer",
      description: "Portal rows we could not parse and ignored",
    },
  },
};

const statusCounts = {
  type: "object",
  additionalProperties: { type: "integer" },
  description: "Meters per install status",
};

export const transformer = {
  type: "object",
  properties: {
    code: { type: "string", example: "DT-003" },
    name: nullable({ type: "string", example: "Vaishali DT 3" }),
    feederCode: nullable({
      type: "string",
      example: "F-003",
      description:
        "As reported by the transformer list; feeder codes are reused, so prefer hierarchy.feeder",
    }),
    capacityKva: nullable({ type: "number", example: 250 }),
    hierarchy,
    meterCount: { type: "integer" },
    statusCounts,
  },
};

export const transformerList = {
  type: "object",
  properties: {
    items: { type: "array", items: transformer },
    total: { type: "integer" },
  },
};

export const transformerDetail = {
  type: "object",
  properties: {
    ...transformer.properties,
    meters: { type: "array", items: meterSummary },
  },
};

export const hierarchyTree = {
  type: "object",
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    zones: {
      type: "array",
      description:
        "Nested tree zone > circle > division > subdivision > substation > feeder > dt. Every node: { level, code, name, meterCount, statusCounts, children[] } (dt nodes also carry capacityKva).",
      items: { type: "object", additionalProperties: true },
    },
  },
};

export const dataQuality = {
  type: "object",
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    summary: { type: "object", additionalProperties: true },
    issues: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
};

export const errorResponse = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
};
