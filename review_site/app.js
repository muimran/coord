import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  collection,
  doc,
  getCountFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { allowedEmails, firebaseConfig } from "./firebase-config.js";

const BD_BOUNDS = { minLat: 20.0, maxLat: 27.5, minLon: 87.0, maxLon: 93.5 };
const STATIONS_COLLECTION = "stations";
const STATUS_PENDING = "pending";
const STATUS_DONE = "done";
const QUEUE_VERSION = "v1";
const OLC_ALPHABET = "23456789CFGHJMPQRVWX";
const OLC_PAIR_RES = [20.0, 1.0, 0.05, 0.0025, 0.000125];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

const state = {
  user: null,
  current: null,
  pendingRows: [],
  pendingById: new Map(),
  queueOrder: [],
  queueCursor: 0,
};

const el = {
  remainingCount: document.getElementById("remainingCount"),
  exactCount: document.getElementById("exactCount"),
  overrideCount: document.getElementById("overrideCount"),
  queueLeftCount: document.getElementById("queueLeftCount"),
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
  approximateToggle: document.getElementById("approximateToggle"),
  message: document.getElementById("message"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  userEmail: document.getElementById("userEmail"),
};

function setMessage(text, kind = "") {
  el.message.textContent = text;
  el.message.className = `message${kind ? ` message--${kind}` : ""}`;
}

function stationIdOf(row) {
  return String(row?.station_result_id || row?.id || "");
}

function queueKey(name) {
  const userPart = (state.user?.email || "anon").toLowerCase();
  return `coord_review_queue_${firebaseConfig.projectId}_${userPart}_${QUEUE_VERSION}_${name}`;
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readStoredOrder() {
  try {
    const raw = localStorage.getItem(queueKey("order"));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function readStoredCursor() {
  try {
    const raw = localStorage.getItem(queueKey("cursor"));
    const parsed = Number.parseInt(raw || "0", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function saveQueueState() {
  try {
    localStorage.setItem(queueKey("order"), JSON.stringify(state.queueOrder));
    localStorage.setItem(queueKey("cursor"), String(state.queueCursor));
  } catch {}
}

function updateQueueLeftCounter() {
  if (!el.queueLeftCount) return;
  if (!state.user) {
    el.queueLeftCount.textContent = "-";
    return;
  }
  const leftIds = new Set();
  for (let i = state.queueCursor; i < state.queueOrder.length; i += 1) {
    const id = state.queueOrder[i];
    if (state.pendingById.has(id)) leftIds.add(id);
  }
  const currentId = stationIdOf(state.current);
  if (currentId && state.pendingById.has(currentId)) leftIds.add(currentId);
  el.queueLeftCount.textContent = String(leftIds.size);
}

function setSignedInUi(user) {
  if (user) {
    el.userEmail.textContent = `Signed in: ${user.email || "unknown"}`;
    el.loginBtn.disabled = true;
    el.logoutBtn.disabled = false;
    return;
  }
  el.userEmail.textContent = "Not signed in";
  el.loginBtn.disabled = false;
  el.logoutBtn.disabled = true;
}

function isAllowedUser(user) {
  if (!user || !user.email) return false;
  if (!allowedEmails || allowedEmails.length === 0) return true;
  return allowedEmails.includes(user.email);
}

function adminHintText(station) {
  const direct =
    station.union_name_bn ||
    station.municipality_name_bn ||
    station.union_ward_name_bn ||
    station.polling_union_bn ||
    station.polling_union_name_bn;
  if (direct) return direct;

  const pipeline = station.pipeline_union_name_bn || station.pipeline_ward_bn;
  if (pipeline) {
    return station.pipeline_upazila_name_bn ? `${pipeline} · ${station.pipeline_upazila_name_bn}` : pipeline;
  }

  if (station.assigned_admin_name_bn) {
    return station.assigned_admin_level
      ? `${station.assigned_admin_name_bn} (${station.assigned_admin_level})`
      : station.assigned_admin_name_bn;
  }
  return "—";
}

function canonicalText(station) {
  if (!station.assigned_admin_name_bn) return "—";
  const parent = station.assigned_parent_name_bn || station.assigned_admin_parent_name_bn || "";
  return parent
    ? `${station.assigned_admin_name_bn} · ${parent}`
    : station.assigned_admin_name_bn;
}

function buildSearchText(station) {
  const adminHint =
    station.union_name_bn ||
    station.municipality_name_bn ||
    station.union_ward_name_bn ||
    station.polling_union_name_bn ||
    station.pipeline_union_name_bn ||
    station.assigned_admin_name_bn ||
    "";
  const upazilaHint =
    station.upazilla_name_bn ||
    station.polling_upazila_bn ||
    station.polling_upazila_name_bn ||
    station.pipeline_upazila_name_bn ||
    station.assigned_admin_parent_name_bn ||
    "";
  const districtHint = station.district_name_bn || station.zilla_name_bn || "";
  const parts = [
    station.center_name_bn || "",
    adminHint,
    upazilaHint,
    districtHint,
    "Bangladesh",
  ];
  return parts.filter(Boolean).join(", ");
}

function renderStation(station) {
  state.current = station;
  el.seatBadge.textContent = `${station.constituency_no || ""} · ${station.constituency_name_bn || ""}`;
  el.methodBadge.textContent = station.location_method || "missing_coordinate";
  el.centerName.textContent = station.center_name_bn || "—";
  el.districtValue.textContent = station.district_name_bn || station.zilla_name_bn || "—";
  el.upazilaValue.textContent =
    station.upazilla_name_bn ||
    station.polling_upazila_bn ||
    station.polling_upazila_name_bn ||
    station.pipeline_upazila_name_bn ||
    station.assigned_admin_parent_name_bn ||
    "—";
  el.adminHintValue.textContent = adminHintText(station);
  el.canonicalValue.textContent = canonicalText(station);
  el.serialValue.textContent = station.center_serial || "—";
  el.stationIdValue.textContent = station.station_result_id || "—";
  station.search_text = buildSearchText(station);
  station.copy_text = station.center_name_bn || "";
  el.googleMapsLink.href = `https://www.google.com/maps/search/${encodeURIComponent(station.search_text)}`;
  el.coordinateInput.value = "";
  if (el.approximateToggle) el.approximateToggle.checked = false;
  setMessage("");
}

function renderEmptyStation(message = "Queue complete.") {
  state.current = null;
  el.seatBadge.textContent = "Seat";
  el.methodBadge.textContent = "Method";
  el.centerName.textContent = message;
  el.districtValue.textContent = "-";
  el.upazilaValue.textContent = "-";
  el.adminHintValue.textContent = "-";
  el.canonicalValue.textContent = "-";
  el.serialValue.textContent = "-";
  el.stationIdValue.textContent = "-";
  el.googleMapsLink.href = "#";
  el.coordinateInput.value = "";
  if (el.approximateToggle) el.approximateToggle.checked = false;
}

function parseCoordinateInput(value) {
  const direct = parseLatLonPair(value);
  if (direct) return { ...direct, source: "latlon_pair" };
  const fromMapsUrl = decodeGoogleMapsUrlCoordinates(value);
  if (fromMapsUrl) return fromMapsUrl;
  return decodeFullPlusCode(value);
}

function parseLatLonPair(value) {
  const cleaned = String(value || "").trim().replace(/\s+/g, "");
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return {
    latitude: Number(match[1]),
    longitude: Number(match[2]),
  };
}

function decodeGoogleMapsUrlCoordinates(value) {
  const input = String(value || "").trim();
  if (!input) return null;

  // Fast path for pasted URL fragments that still carry coordinates.
  const rawDirect = decodeURIComponentSafe(input);
  const directAt = rawDirect.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/);
  if (directAt) {
    return {
      latitude: Number(directAt[1]),
      longitude: Number(directAt[2]),
      source: "google_maps_url",
    };
  }
  const direct3d4d = rawDirect.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (direct3d4d) {
    return {
      latitude: Number(direct3d4d[1]),
      longitude: Number(direct3d4d[2]),
      source: "google_maps_url",
    };
  }

  let raw = input;
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    if (raw.startsWith("www.") || raw.startsWith("google.") || raw.startsWith("maps.")) {
      raw = `https://${raw}`;
    } else {
      return null;
    }
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isGoogleHost = /(^|\.)google\./.test(host) || host === "maps.app.goo.gl";
  const looksMapsPath = url.pathname.includes("/maps") || url.pathname.includes("/place/") || url.pathname.includes("/search/");
  if (!isGoogleHost || (!host.includes("maps") && !looksMapsPath)) return null;

  // 1) Most common format: .../@22.4936781,89.0085818,17z/...
  const atMatch = decodeURIComponentSafe(url.pathname).match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/);
  if (atMatch) {
    return {
      latitude: Number(atMatch[1]),
      longitude: Number(atMatch[2]),
      source: "google_maps_url",
    };
  }

  // 2) Place data segment: ...!3d22.4936781!4d89.0085818...
  const dataSegment = decodeURIComponentSafe(`${url.pathname}${url.search}`);
  const dMatch = dataSegment.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (dMatch) {
    return {
      latitude: Number(dMatch[1]),
      longitude: Number(dMatch[2]),
      source: "google_maps_url",
    };
  }

  // 3) Query parameters sometimes carry coordinate pair.
  const ll = parseLatLonPair(url.searchParams.get("ll"));
  if (ll) return { ...ll, source: "google_maps_url" };
  const q = parseLatLonPair(url.searchParams.get("q"));
  if (q) return { ...q, source: "google_maps_url" };
  const query = parseLatLonPair(url.searchParams.get("query"));
  if (query) return { ...query, source: "google_maps_url" };

  return null;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function coordinatesInBounds(latitude, longitude) {
  return (
    latitude >= BD_BOUNDS.minLat &&
    latitude <= BD_BOUNDS.maxLat &&
    longitude >= BD_BOUNDS.minLon &&
    longitude <= BD_BOUNDS.maxLon
  );
}

function extractPlusCodeCandidate(value) {
  const upper = String(value || "").toUpperCase();
  const candidates = upper.split(/[\s,;]+/).filter(Boolean);
  for (const token of candidates) {
    if (token.includes("+")) return token;
  }
  return null;
}

function decodeFullPlusCode(rawValue) {
  const token = extractPlusCodeCandidate(rawValue);
  if (!token) return null;

  const plusIndex = token.indexOf("+");
  if (plusIndex < 0) return null;

  const left = token.slice(0, plusIndex).replace(/0/g, "");
  const right = token.slice(plusIndex + 1).replace(/0/g, "");
  // Require a full code (at least 8 chars before '+').
  if (left.length < 8 || right.length < 2) return null;

  const code = `${left}+${right}`;
  const codeNoPlus = `${left}${right}`;
  if (codeNoPlus.length < 10) return null;

  for (const ch of codeNoPlus) {
    if (!OLC_ALPHABET.includes(ch)) return null;
  }

  let lat = -90.0;
  let lon = -180.0;
  let latPlace = OLC_PAIR_RES[OLC_PAIR_RES.length - 1];
  let lonPlace = OLC_PAIR_RES[OLC_PAIR_RES.length - 1];

  const pairCount = Math.min(10, codeNoPlus.length);
  for (let i = 0; i < pairCount; i += 2) {
    const pairPos = Math.floor(i / 2);
    latPlace = OLC_PAIR_RES[pairPos];
    lonPlace = OLC_PAIR_RES[pairPos];
    const latVal = OLC_ALPHABET.indexOf(codeNoPlus[i]);
    const lonVal = OLC_ALPHABET.indexOf(codeNoPlus[i + 1]);
    if (latVal < 0 || lonVal < 0) return null;
    lat += latVal * latPlace;
    lon += lonVal * lonPlace;
  }

  // Grid refinement beyond 10 digits (4 columns x 5 rows).
  let gridLatPlace = latPlace / 5.0;
  let gridLonPlace = lonPlace / 4.0;
  for (let i = 10; i < codeNoPlus.length; i += 1) {
    const v = OLC_ALPHABET.indexOf(codeNoPlus[i]);
    if (v < 0) return null;
    const row = Math.floor(v / 4);
    const col = v % 4;
    lat += row * gridLatPlace;
    lon += col * gridLonPlace;
    latPlace = gridLatPlace;
    lonPlace = gridLonPlace;
    gridLatPlace /= 5.0;
    gridLonPlace /= 4.0;
  }

  return {
    latitude: Number((lat + latPlace / 2.0).toFixed(8)),
    longitude: Number((lon + lonPlace / 2.0).toFixed(8)),
    source: "plus_code",
    plusCode: code,
  };
}

async function refreshStats() {
  const stationsRef = collection(db, STATIONS_COLLECTION);
  const totalSnap = await getCountFromServer(stationsRef);
  const pendingSnap = await getCountFromServer(query(stationsRef, where("status", "==", STATUS_PENDING)));
  const total = Number(totalSnap.data().count || 0);
  const pending = Number(pendingSnap.data().count || 0);
  const done = total - pending;
  el.remainingCount.textContent = pending;
  el.exactCount.textContent = total;
  el.overrideCount.textContent = done;
}

function rebuildQueueFromPending() {
  const pendingIds = new Set(state.pendingRows.map((row) => stationIdOf(row)).filter(Boolean));
  const storedOrderRaw = readStoredOrder().map(String).filter(Boolean);
  const seenOrder = [];
  const unseenOrder = [];
  const seenRaw = new Set(storedOrderRaw.slice(0, readStoredCursor()));
  const knownInStored = new Set(storedOrderRaw);

  for (const id of storedOrderRaw) {
    if (!pendingIds.has(id)) continue;
    if (seenRaw.has(id)) seenOrder.push(id);
    else unseenOrder.push(id);
  }

  const newIds = [];
  for (const id of pendingIds) {
    if (!knownInStored.has(id)) newIds.push(id);
  }

  state.queueOrder = [...seenOrder, ...unseenOrder, ...shuffle(newIds)];
  state.queueCursor = seenOrder.length;
  saveQueueState();
}

async function loadPendingRows() {
  const snap = await getDocs(query(collection(db, STATIONS_COLLECTION), where("status", "==", STATUS_PENDING)));
  state.pendingRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.pendingById = new Map();
  for (const row of state.pendingRows) {
    const id = stationIdOf(row);
    if (!id) continue;
    state.pendingById.set(id, row);
  }
  rebuildQueueFromPending();
  updateQueueLeftCounter();
}

function loadNextQueueStation() {
  if (state.pendingById.size === 0) {
    renderEmptyStation("All unresolved stations have been reviewed.");
    updateQueueLeftCounter();
    setMessage("No unresolved stations remain.", "success");
    return;
  }

  while (state.queueCursor < state.queueOrder.length) {
    const id = state.queueOrder[state.queueCursor];
    state.queueCursor += 1;
    const row = state.pendingById.get(id);
    if (!row) continue;
    saveQueueState();
    renderStation(row);
    updateQueueLeftCounter();
    return;
  }

  saveQueueState();
  renderEmptyStation("Queue complete for this pass.");
  updateQueueLeftCounter();
  setMessage("Every pending station has been shown once. Refresh to rebuild a new queue.", "success");
}

async function saveCoordinate(event) {
  event.preventDefault();
  if (!state.user) {
    setMessage("Please sign in first.", "error");
    return;
  }
  if (!state.current) return;
  const parsed = parseCoordinateInput(el.coordinateInput.value);
  if (!parsed) {
    setMessage("Use `latitude, longitude`, a full Plus Code, or a Google Maps place URL.", "error");
    return;
  }
  if (!coordinatesInBounds(parsed.latitude, parsed.longitude)) {
    setMessage("Coordinates are outside Bangladesh bounds.", "error");
    return;
  }
  const isApproximate = Boolean(el.approximateToggle?.checked);

  const stationId = String(state.current.station_result_id || state.current.id || "");
  if (!stationId) {
    setMessage("Missing station id.", "error");
    return;
  }

  await updateDoc(doc(db, STATIONS_COLLECTION, stationId), {
    status: STATUS_DONE,
    latitude: Number(parsed.latitude.toFixed(8)),
    longitude: Number(parsed.longitude.toFixed(8)),
    coordinate_input_source: parsed.source || "latlon_pair",
    coordinate_is_approximate: isApproximate,
    reviewer: state.user.email || "reviewer",
    saved_at_utc: new Date().toISOString(),
    updated_at: serverTimestamp(),
  });

  state.pendingRows = state.pendingRows.filter((row) => stationIdOf(row) !== stationId);
  state.pendingById.delete(stationId);
  await refreshStats();
  loadNextQueueStation();
  if (isApproximate) {
    setMessage("Saved as approximate. Loading the next station…", "success");
  } else {
    setMessage("Saved. Loading the next station…", "success");
  }
}

async function copyText(text, successLabel) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setMessage(successLabel, "success");
}

async function bootForUser(user) {
  if (!isAllowedUser(user)) {
    setMessage("Signed-in account is not allowed by app config.", "error");
    await signOut(auth);
    return;
  }
  await refreshStats();
  await loadPendingRows();
  loadNextQueueStation();
}

el.copyCenterName.addEventListener("click", () => {
  if (!state.current) return;
  copyText(state.current.copy_text, "Centre name copied.");
});

el.copySearchText.addEventListener("click", () => {
  if (!state.current) return;
  copyText(state.current.search_text, "Search text copied.");
});

el.nextRandom.addEventListener("click", () => loadNextQueueStation());
el.coordinateForm.addEventListener("submit", saveCoordinate);

el.loginBtn.addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    setMessage(error?.message || "Login failed.", "error");
  }
});

el.logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (error) {
    setMessage(error?.message || "Logout failed.", "error");
  }
});

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  setSignedInUi(user);
  if (!user) {
    renderEmptyStation("Sign in to start review.");
    state.pendingRows = [];
    state.pendingById = new Map();
    state.queueOrder = [];
    state.queueCursor = 0;
    updateQueueLeftCounter();
    setMessage("Sign in to start review.", "");
    return;
  }
  try {
    await bootForUser(user);
  } catch (error) {
    setMessage(error?.message || "Could not load review data.", "error");
  }
});
