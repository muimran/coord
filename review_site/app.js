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
};

const el = {
  remainingCount: document.getElementById("remainingCount"),
  exactCount: document.getElementById("exactCount"),
  overrideCount: document.getElementById("overrideCount"),
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
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  userEmail: document.getElementById("userEmail"),
};

function setMessage(text, kind = "") {
  el.message.textContent = text;
  el.message.className = `message${kind ? ` message--${kind}` : ""}`;
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
  setMessage("");
}

function parseCoordinateInput(value) {
  const direct = parseLatLonPair(value);
  if (direct) return direct;
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
  const raw = String(value || "").trim();
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.includes("google.") || !host.includes("maps")) return null;

  // 1) Most common format: .../@22.4936781,89.0085818,17z/...
  const atMatch = decodeURIComponent(url.pathname).match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/);
  if (atMatch) {
    return {
      latitude: Number(atMatch[1]),
      longitude: Number(atMatch[2]),
      source: "google_maps_url",
    };
  }

  // 2) Place data segment: ...!3d22.4936781!4d89.0085818...
  const dataSegment = decodeURIComponent(`${url.pathname}${url.search}`);
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

async function loadPendingRows() {
  const snap = await getDocs(query(collection(db, STATIONS_COLLECTION), where("status", "==", STATUS_PENDING)));
  state.pendingRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function loadRandomStation() {
  if (state.pendingRows.length === 0) {
    state.current = null;
    setMessage("No unresolved stations remain.", "success");
    return;
  }
  const pick = state.pendingRows[Math.floor(Math.random() * state.pendingRows.length)];
  renderStation(pick);
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

  const stationId = String(state.current.station_result_id || state.current.id || "");
  if (!stationId) {
    setMessage("Missing station id.", "error");
    return;
  }

  await updateDoc(doc(db, STATIONS_COLLECTION, stationId), {
    status: STATUS_DONE,
    latitude: Number(parsed.latitude.toFixed(8)),
    longitude: Number(parsed.longitude.toFixed(8)),
    reviewer: state.user.email || "reviewer",
    saved_at_utc: new Date().toISOString(),
    updated_at: serverTimestamp(),
  });

  state.pendingRows = state.pendingRows.filter(
    (row) => String(row.station_result_id || row.id || "") !== stationId,
  );
  await refreshStats();
  loadRandomStation();
  setMessage("Saved. Loading the next station…", "success");
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
  loadRandomStation();
}

el.copyCenterName.addEventListener("click", () => {
  if (!state.current) return;
  copyText(state.current.copy_text, "Centre name copied.");
});

el.copySearchText.addEventListener("click", () => {
  if (!state.current) return;
  copyText(state.current.search_text, "Search text copied.");
});

el.nextRandom.addEventListener("click", () => loadRandomStation());
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
    state.current = null;
    state.pendingRows = [];
    setMessage("Sign in to start review.", "");
    return;
  }
  try {
    await bootForUser(user);
  } catch (error) {
    setMessage(error?.message || "Could not load review data.", "error");
  }
});
