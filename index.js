/**
 * Azure Function: GetVisitLocation
 * HTTP Trigger — GET /api/GetVisitLocation?token=XXXX
 *
 * Reads vntx_latitude, vntx_longitude, vntx_checkintime, and related
 * Work Order name from the vntx_timeentry record whose vntx_trackingtoken
 * matches the supplied token.
 *
 * Returns:
 *   200 { latitude, longitude, checkedIn, workOrderName, lastUpdated }
 *   404 { error: "Not found" }           — token invalid / expired
 *   400 { error: "Token required" }      — no token supplied
 *   500 { error: "..." }                 — internal error
 */

const { ClientSecretCredential } = require("@azure/identity");

// ── Dataverse Web API helpers ──────────────────────────────────────────────

async function getDataverseToken(credential, orgUrl) {
  const token = await credential.getToken(`${orgUrl}/.default`);
  return token.token;
}

async function fetchVisitByToken(orgUrl, accessToken, trackingToken) {
  // OData query: find the visit whose vntx_trackingtoken matches
  const select = [
    "vntx_timeentryid",
    "vntx_latitude",
    "vntx_longitude",
    "vntx_checkintime",
    "vntx_trackingtoken",
    "_vntx_workorderid_value"
  ].join(",");

  // Encode the token for use in OData filter
  const safeToken = trackingToken.replace(/'/g, "''");
  const filter    = `vntx_trackingtoken eq '${safeToken}'`;

  const url = `${orgUrl}/api/data/v9.2/vntx_timeentries?$select=${select}&$filter=${encodeURIComponent(filter)}&$top=1`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Dataverse query failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.value && data.value.length > 0 ? data.value[0] : null;
}

async function fetchWorkOrderName(orgUrl, accessToken, workOrderId) {
  if (!workOrderId) return null;
  const cleanId = workOrderId.replace(/[{}]/g, "");
  const url = `${orgUrl}/api/data/v9.2/vntx_workorders(${cleanId})?$select=vntx_name`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.vntx_name || null;
  } catch {
    return null;
  }
}

// ── Main function entry point ──────────────────────────────────────────────

module.exports = async function (context, req) {
  // CORS headers — allow your GitHub Pages domain
  const corsOrigin = process.env.ALLOWED_ORIGIN || "*";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache"
  };

  // Handle preflight
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers };
    return;
  }

  // Read token from query string
  const token = req.query.token || "";
  if (!token.trim()) {
    context.res = { status: 400, headers, body: JSON.stringify({ error: "Token required" }) };
    return;
  }

  try {
    // Build Azure AD credential using environment variables
    const credential = new ClientSecretCredential(
      process.env.AZURE_TENANT_ID,
      process.env.AZURE_CLIENT_ID,
      process.env.AZURE_CLIENT_SECRET
    );

    const orgUrl     = process.env.DATAVERSE_ORG_URL; // e.g. https://fieldservicelitez.crm8.dynamics.com
    const accessToken = await getDataverseToken(credential, orgUrl);

    // Query the Visit record by tracking token
    const visit = await fetchVisitByToken(orgUrl, accessToken, token);

    if (!visit) {
      context.res = { status: 404, headers, body: JSON.stringify({ error: "Not found" }) };
      return;
    }

    // Fetch Work Order name
    const workOrderId   = visit["_vntx_workorderid_value"] || null;
    const workOrderName = await fetchWorkOrderName(orgUrl, accessToken, workOrderId);

    // Build response
    const lat       = visit["vntx_latitude"]    ? parseFloat(visit["vntx_latitude"])    : null;
    const lng       = visit["vntx_longitude"]   ? parseFloat(visit["vntx_longitude"])   : null;
    const checkIn   = visit["vntx_checkintime"] || null;
    const checkedIn = !!checkIn;

    const response = {
      latitude:      lat,
      longitude:     lng,
      checkedIn:     checkedIn,
      checkInTime:   checkIn,
      workOrderName: workOrderName || "Field Service Visit",
      lastUpdated:   new Date().toISOString()
    };

    context.res = {
      status: 200,
      headers,
      body: JSON.stringify(response)
    };

  } catch (err) {
    context.log.error("GetVisitLocation error:", err.message);
    context.res = {
      status: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error" })
    };
  }
};
