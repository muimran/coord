const config = window.COORDINATE_REVIEW_CONFIG || {};
const GITHUB_DISPATCH_URL = config.githubDispatchUrl || "";
const GITHUB_REF = config.githubRef || "main";
const GITHUB_TOKEN = config.githubToken || "";
const FEED_PATH = config.unresolvedFeedPath || "../data/review/unresolved_stations.json";
const LOCAL_REVIEWED_KEY = "coordinate-review-reviewed-ids";

const state = {
  feed: [],
  current: null,
  reviewedIds: new Set(JSON.parse(localStorage.getItem(LOCAL_REVIEWED_KEY) || "[]")),
};

const el = {
  remainingCount: document.getElementById("remainingCount"),
  localReviewedCount: document.getElementById("localReviewedCount"),
  currentIndex: document.getElementById("currentIndex"),
  seatBadge: document.getElementById("seatBadge"),
  methodBadge: document.getElementById("methodBadge"),
  centerName: document.getElementById("centerName"),
  districtValue: document.getElementById("districtValue"),
  upazilaValue: document.getElementById("upazilaValue"),
  adminHintValue: document.getElementById("adminHintValue"),
  canonicalValue: document.getElementById("canonicalValue"),
  serialValue: document.getElementById("serialValue"),
  stationIdValue: document.getElementById("stationIdValue"),
  copyCenterName: document.getElementById("copyCenterName"),
  copySearchText: document.getElementById("copySearchText"),
  googleMapsLink: document.getElementById("googleMapsLink"),
  nextRandom: document.getElementById("nextRandom"),
  coordinateForm: document.getElementById("coordinateForm"),
  coordinateInput: document.getElementById("coordinateInput"),
  message: document.getElementById("message"),
};

function persistReviewedIds() {
  localStorage.setItem(LOCAL_REVIEWED_KEY, JSON.stringify(Array.from(state.reviewedIds)));
}

function setMessage(text, kind = "") {
  el.message.textContent = text;
  el.message.className = `message${kind ? ` message--${kind}` : ""}`;
}

function adminHintText(station) {
  return station.union_name_bn || station.municipality_name_bn || station.union_ward_name_bn || station.polling_union_bn || "—";
}

function canonicalText(station) {
  if (!station.assigned_admin_name_bn) return "—";
  return station.assigned_parent_name_bn
    ? `${station.assigned_admin_name_bn} · ${station.assigned_parent_name_bn}`
    : station.assigned_admin_name_bn;
}

function availableFeed() {
  return state.feed.filter((row) => !state.reviewedIds.has(row.station_result_id));
}

function updateStats() {
  el.remainingCount.textContent = availableFeed().length;
  el.localReviewedCount.textContent = state.reviewedIds.size;
}

function renderStation(station) {
  state.current = station;
  el.seatBadge.textContent = `${station.constituency_no} · ${station.constituency_name_bn}`;
  el.methodBadge.textContent = station.location_method || "missing_coordinate";
  el.centerName.textContent = station.center_name_bn || "—";
  el.districtValue.textContent = station.district_name_bn || "—";
  el.upazilaValue.textContent = station.upazilla_name_bn || station.polling_upazila_bn || "—";
  el.adminHintValue.textContent = adminHintText(station);
  el.canonicalValue.textContent = canonicalText(station);
  el.serialValue.textContent = station.center_serial || "—";
  el.stationIdValue.textContent = station.station_result_id || "—";
  el.googleMapsLink.href = station.google_maps_url;
  el.coordinateInput.value = "";
  const visibleIndex = state.feed.findIndex((row) => row.station_result_id === station.station_result_id) + 1;
  el.currentIndex.textContent = `${visibleIndex}/${state.feed.length}`;
  setMessage("");
  updateStats();
}

function parseCoordinateInput(value) {
  const cleaned = value.trim().replace(/\s+/g, "");
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return { latitude: Number(match[1]), longitude: Number(match[2]) };
}

async function copyText(text, successLabel) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setMessage(successLabel, "success");
}

async function saveCoordinate(event) {
  event.preventDefault();
  if (!state.current) return;
  if (!GITHUB_DISPATCH_URL || !GITHUB_TOKEN || GITHUB_TOKEN.includes("PASTE_YOUR_FINE_GRAINED_GITHUB_TOKEN_HERE")) {
    setMessage("Set review_site/config.js with your GitHub token and dispatch URL first.", "error");
    return;
  }
  const parsed = parseCoordinateInput(el.coordinateInput.value);
  if (!parsed) {
    setMessage("Use `latitude, longitude` format.", "error");
    return;
  }

  const response = await fetch(GITHUB_DISPATCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: GITHUB_REF,
      inputs: {
        station_result_id: String(state.current.station_result_id),
        latitude: String(parsed.latitude),
        longitude: String(parsed.longitude),
        center_name_bn: state.current.center_name_bn || "",
        constituency_no: String(state.current.constituency_no || ""),
        constituency_name_bn: state.current.constituency_name_bn || "",
      },
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    setMessage(payload.error || "Save failed.", "error");
    return;
  }

  state.reviewedIds.add(state.current.station_result_id);
  persistReviewedIds();
  setMessage("Saved. Loading the next station…", "success");
  loadRandom();
}

function loadRandom() {
  const candidates = availableFeed();
  if (!candidates.length) {
    state.current = null;
    setMessage("No unresolved stations remain in the current feed.", "success");
    updateStats();
    return;
  }
  const station = candidates[Math.floor(Math.random() * candidates.length)];
  renderStation(station);
}

async function init() {
  const response = await fetch(FEED_PATH);
  state.feed = await response.json();
  updateStats();
  loadRandom();
}

el.copyCenterName.addEventListener("click", () => state.current && copyText(state.current.copy_text, "Centre name copied."));
el.copySearchText.addEventListener("click", () => state.current && copyText(state.current.search_text, "Search text copied."));
el.nextRandom.addEventListener("click", loadRandom);
el.coordinateForm.addEventListener("submit", saveCoordinate);

init().catch(() => setMessage("Could not initialize the review page.", "error"));
