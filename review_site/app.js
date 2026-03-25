const state = {
  current: null,
  seenIds: new Set(),
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
};

function setMessage(text, kind = "") {
  el.message.textContent = text;
  el.message.className = `message${kind ? ` message--${kind}` : ""}`;
}

function adminHintText(station) {
  return (
    station.union_name_bn ||
    station.municipality_name_bn ||
    station.union_ward_name_bn ||
    station.polling_union_bn ||
    "—"
  );
}

function canonicalText(station) {
  if (!station.assigned_admin_name_bn) return "—";
  return station.assigned_parent_name_bn
    ? `${station.assigned_admin_name_bn} · ${station.assigned_parent_name_bn}`
    : station.assigned_admin_name_bn;
}

function renderStation(station) {
  state.current = station;
  state.seenIds.add(station.station_result_id);
  el.seatBadge.textContent = `${station.constituency_no} · ${station.constituency_name_bn}`;
  el.methodBadge.textContent = station.location_method || "missing_coordinate";
  el.centerName.textContent = station.center_name_bn || "—";
  el.districtValue.textContent = station.district_name_bn || "—";
  el.upazilaValue.textContent =
    station.upazilla_name_bn || station.polling_upazila_bn || station.assigned_parent_name_bn || "—";
  el.adminHintValue.textContent = adminHintText(station);
  el.canonicalValue.textContent = canonicalText(station);
  el.serialValue.textContent = station.center_serial || "—";
  el.stationIdValue.textContent = station.station_result_id || "—";
  el.googleMapsLink.href = station.google_maps_url;
  el.coordinateInput.value = "";
  setMessage("");
}

async function loadStats() {
  const res = await fetch("/api/stats");
  const data = await res.json();
  el.remainingCount.textContent = data.remainingMissingCoordinates;
  el.exactCount.textContent = data.withExactCoordinates;
  el.overrideCount.textContent = data.savedOverrides;
}

async function loadRandom() {
  const exclude = Array.from(state.seenIds).slice(-50).join(",");
  const url = exclude ? `/api/station/random?exclude=${encodeURIComponent(exclude)}` : "/api/station/random";
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    setMessage(data.error || "Could not load a station.", "error");
    return;
  }
  renderStation(data);
}

function parseCoordinateInput(value) {
  const cleaned = value.trim().replace(/\s+/g, "");
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return {
    latitude: Number(match[1]),
    longitude: Number(match[2]),
  };
}

async function saveCoordinate(event) {
  event.preventDefault();
  if (!state.current) return;
  const parsed = parseCoordinateInput(el.coordinateInput.value);
  if (!parsed) {
    setMessage("Use `latitude, longitude` format.", "error");
    return;
  }
  const res = await fetch("/api/save-coordinate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      station_result_id: state.current.station_result_id,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    setMessage(data.error || "Could not save coordinates.", "error");
    return;
  }
  setMessage("Saved. Loading the next station…", "success");
  await loadStats();
  await loadRandom();
}

async function copyText(text, successLabel) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setMessage(successLabel, "success");
}

el.copyCenterName.addEventListener("click", () => {
  if (!state.current) return;
  copyText(state.current.copy_text, "Centre name copied.");
});

el.copySearchText.addEventListener("click", () => {
  if (!state.current) return;
  copyText(state.current.search_text, "Search text copied.");
});

el.nextRandom.addEventListener("click", () => loadRandom());
el.coordinateForm.addEventListener("submit", saveCoordinate);

Promise.all([loadStats(), loadRandom()]).catch(() => {
  setMessage("Could not initialize the review page.", "error");
});
