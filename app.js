(function () {
  const SEOCHO_CENTER = [37.4837, 127.0324];
  const CROSSING_DANGER_M = 26;
  const CROSSING_WARN_M = 48;
  const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1";

  const LOCAL_PLACES = {
    "양재역": [37.484147, 127.034631],
    "강남역": [37.497952, 127.027619],
    "교대역": [37.493415, 127.01408],
    "고속터미널역": [37.504914, 127.004915],
    "사당역": [37.47653, 126.981685],
    "남부터미널역": [37.485013, 127.016189],
    "서초역": [37.491897, 127.007917],
    "방배역": [37.48148, 126.997535],
    "내방역": [37.487618, 126.993513],
    "반포역": [37.508184, 127.011373],
    "신논현역": [37.504598, 127.02506],
    "양재시민의숲역": [37.470023, 127.03842],
    "서초구청": [37.483624, 127.032683],
    "서울고교": [37.486676, 127.005983],
    "반포종합운동장": [37.499159, 126.996548],
    "예술의전당": [37.478215, 127.011549],
    "서울교대": [37.490849, 127.015424],
    "서리풀공원": [37.489551, 126.999048],
    "양재천": [37.47375, 127.03855],
  };

  const state = {
    crossings: [],
    route: null,
    start: null,
    end: null,
    targetKm: 5,
    attempt: 0,
  };

  const form = document.querySelector("#routeForm");
  const rerouteButton = document.querySelector("#rerouteButton");
  const statusText = document.querySelector("#statusText");
  const distanceMetric = document.querySelector("#distanceMetric");
  const avoidMetric = document.querySelector("#avoidMetric");
  const primaryButton = document.querySelector(".primary-action");
  const crossingOverlay = document.querySelector("#crossingOverlay");

  const map = L.map("map", { zoomControl: false }).setView(SEOCHO_CENTER, 13);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);
  map.createPane("routePane");
  map.getPane("routePane").style.zIndex = 430;

  const routeLayer = L.layerGroup().addTo(map);

  init();

  function init() {
    lucide.createIcons();
    bindDistancePicker();
    loadCrossings();
    map.whenReady(drawCrossings);
    queueMapResize();
    form.addEventListener("submit", handleSubmit);
    rerouteButton.addEventListener("click", async () => {
      if (!state.start || !state.end) return;
      state.attempt += 1;
      setBusy(true);
      statusText.textContent = "보행 전용 후보 코스를 계산하는 중입니다.";
      try {
        await recommendRoute();
      } catch (error) {
        statusText.textContent = error.message;
      } finally {
        setBusy(false);
      }
    });
    map.on("moveend zoomend resize", drawCrossings);
    window.addEventListener("resize", queueMapResize);
  }

  function bindDistancePicker() {
    document.querySelectorAll(".segmented").forEach((label) => {
      label.addEventListener("click", () => {
        document.querySelectorAll(".segmented").forEach((item) => item.classList.remove("active"));
        label.classList.add("active");
      });
    });
  }

  function loadCrossings() {
    proj4.defs(
      "EPSG:5174",
      "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs"
    );
    state.crossings = (window.SEOCHO_CROSSINGS || [])
      .map((item) => {
        const [lng, lat] = proj4("EPSG:5174", "WGS84", [item.x, item.y]);
        return { ...item, lat, lng };
      })
      .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
  }

  function drawCrossings() {
    if (!crossingOverlay) return;
    crossingOverlay.replaceChildren();
    const fragment = document.createDocumentFragment();
    const bounds = map.getBounds().pad(0.08);

    state.crossings.forEach((item) => {
      const latLng = L.latLng(item.lat, item.lng);
      if (!bounds.contains(latLng)) return;

      const point = map.latLngToContainerPoint(latLng);
      const marker = document.createElement("span");
      marker.className = "crossing-pin";
      marker.style.left = `${point.x}px`;
      marker.style.top = `${point.y}px`;
      marker.title = item.address || item.name || "횡단보도";
      fragment.appendChild(marker);
    });

    crossingOverlay.appendChild(fragment);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    statusText.textContent = "입력 지점을 확인하고 횡단보도 회피 후보를 계산하는 중입니다.";
    try {
      const data = new FormData(form);
      state.start = await resolvePlace(data.get("start"));
      state.end = await resolvePlace(data.get("end"));
      state.targetKm = Number(data.get("distance"));
      state.attempt = 0;
      await recommendRoute();
    } catch (error) {
      statusText.textContent = error.message;
      clearMetrics();
    } finally {
      setBusy(false);
    }
  }

  async function resolvePlace(value) {
    const query = String(value || "").trim();
    const coordinate = parseCoordinate(query);
    if (coordinate) return { label: query, lat: coordinate[0], lng: coordinate[1] };

    const localKey = Object.keys(LOCAL_PLACES).find((key) => query.includes(key) || key.includes(query));
    if (localKey) {
      const [lat, lng] = LOCAL_PLACES[localKey];
      return { label: localKey, lat, lng };
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("q", `${query}, 서초구, 서울`);

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("장소 검색에 실패했습니다. 서초구 지명이나 위경도를 입력해 주세요.");
    const [item] = await response.json();
    if (!item) throw new Error("장소를 찾지 못했습니다. 예: 양재역, 서초구청, 37.48,127.03");
    return { label: query, lat: Number(item.lat), lng: Number(item.lon) };
  }

  function parseCoordinate(query) {
    const match = query.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b];
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return [b, a];
    return null;
  }

  async function recommendRoute() {
    statusText.textContent = "후보 경유지를 실제 보행 전용 네트워크에 맞춰 계산하는 중입니다.";
    rerouteButton.disabled = true;
    const candidates = buildCandidates(state.start, state.end, state.targetKm, state.attempt);
    const routedCandidates = [];

    for (const waypoints of candidates) {
      const routes = await fetchRoutedCandidates(waypoints);
      routedCandidates.push(...routes);
    }

    if (!routedCandidates.length) {
      state.route = null;
      routeLayer.clearLayers();
      clearMetrics();
      throw new Error("보행 경로를 찾을 수 없습니다.");
    }

    const scored = routedCandidates
      .map((route) => scoreRoute(route.points, state.targetKm, route))
      .sort(compareRoutes);
    state.route = scored[0];
    renderRoute(state.route);
  }

  function buildCandidates(start, end, targetKm, attempt) {
    const directM = distanceMeters(start, end);
    const targetM = targetKm * 1000;
    const baseBearing = bearingRadians(start, end);
    const candidates = [[start, end]];
    const seed = attempt * 0.47;
    const factors = [0.62, 0.92, 1.2, 1.5];

    for (let side of [-1, 1]) {
      for (let i = 0; i < factors.length; i += 1) {
        const desired = Math.max(targetM, directM * 1.05);
        const leg = desired / 3;
        const height = Math.sqrt(Math.max(0, leg * leg - (directM / 3) * (directM / 3)));
        const wobble = (Math.sin(seed + i * 1.7) * 0.18 + 1) * factors[i];
        const offset = Math.min(Math.max(height * wobble, 260), targetKm === 10 ? 3600 : 1900);
        const alongA = 0.28 + ((i + attempt) % 3) * 0.08;
        const alongB = 0.72 - ((i + attempt) % 3) * 0.06;
        const p1 = offsetPoint(interpolate(start, end, alongA), baseBearing + Math.PI / 2, offset * side);
        const p2 = offsetPoint(interpolate(start, end, alongB), baseBearing + Math.PI / 2, offset * side * 0.86);
        candidates.push(relaxAwayFromCrossings([start, p1, p2, end], i + attempt));

        const back = offsetPoint(interpolate(start, end, 0.5), baseBearing - Math.PI / 2, offset * side * 0.52);
        candidates.push(relaxAwayFromCrossings([start, p1, back, p2, end], i + attempt + 3));
      }
    }

    return candidates;
  }

  function relaxAwayFromCrossings(points, seed) {
    return points.map((point, index) => {
      if (index === 0 || index === points.length - 1) return point;
      const nearby = state.crossings
        .map((crossing) => ({ crossing, d: distanceMeters(point, crossing) }))
        .filter((item) => item.d < 170)
        .sort((a, b) => a.d - b.d)
        .slice(0, 8);
      if (!nearby.length) return point;
      let latPush = 0;
      let lngPush = 0;
      nearby.forEach(({ crossing, d }) => {
        const power = (170 - d) / 170;
        latPush += (point.lat - crossing.lat) * power;
        lngPush += (point.lng - crossing.lng) * power;
      });
      const angle = Math.atan2(latPush, lngPush) + seed * 0.13;
      return offsetPoint(point, angle, 150 + nearby.length * 18);
    });
  }

  async function fetchRoutedCandidates(waypoints) {
    try {
      return await requestOsrmFootRoutes(waypoints);
    } catch (error) {
      return [];
    }
  }

  async function requestOsrmFootRoutes(waypoints) {
    const coordinates = waypoints.map((point) => `${point.lng},${point.lat}`).join(";");
    const url = new URL(`${OSRM_BASE_URL}/foot/${coordinates}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "false");
    url.searchParams.set("alternatives", "true");
    url.searchParams.set("continue_straight", "false");

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error("보행 경로를 찾을 수 없습니다.");
    const data = await response.json();
    if (data.code !== "Ok" || !Array.isArray(data.routes)) {
      throw new Error("보행 경로를 찾을 수 없습니다.");
    }

    return data.routes
      .map((route, index) => {
        const coordinatesList = route.geometry && route.geometry.coordinates;
        if (!coordinatesList || coordinatesList.length < 2) return null;
        return {
          points: coordinatesList.map(([lng, lat]) => ({ lat, lng })),
          lengthM: route.distance,
          profile: "foot",
          alternativeIndex: index,
        };
      })
      .filter(Boolean);
  }

  function scoreRoute(points, targetKm, routed = {}) {
    let lengthM = routed.lengthM || 0;
    let danger = 0;
    let warning = 0;
    if (!lengthM) lengthM = pathLengthMeters(points);
    for (let i = 0; i < points.length - 1; i += 1) {
      for (const crossing of state.crossings) {
        const d = distancePointToSegment(crossing, points[i], points[i + 1]);
        if (d < CROSSING_DANGER_M) danger += 1;
        else if (d < CROSSING_WARN_M) warning += 1;
      }
    }
    const targetM = targetKm * 1000;
    const distancePenalty = Math.abs(lengthM - targetM) / 18;
    const shortPenalty = lengthM < targetM * 0.82 ? (targetM * 0.82 - lengthM) / 4 : 0;
    return {
      points,
      lengthM,
      danger,
      warning,
      profile: routed.profile || "line",
      score: danger * 190 + warning * 30 + distancePenalty + shortPenalty,
    };
  }

  function compareRoutes(a, b) {
    if (a.danger !== b.danger) return a.danger - b.danger;
    if (a.warning !== b.warning) return a.warning - b.warning;
    return a.score - b.score;
  }

  function renderRoute(route) {
    routeLayer.clearLayers();
    map.invalidateSize();
    const latLngs = route.points.map((point) => [point.lat, point.lng]);

    L.polyline(latLngs, {
      pane: "routePane",
      color: "#1ed760",
      weight: 9,
      opacity: 0.96,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(routeLayer);
    L.polyline(latLngs, {
      pane: "routePane",
      color: "#0d0d0d",
      weight: 3,
      opacity: 0.35,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(routeLayer);

    addPin(state.start, "시작점", routeLayer);
    addPin(state.end, "도착점", routeLayer);

    const bounds = L.latLngBounds(latLngs).pad(0.18);
    requestAnimationFrame(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { animate: true, maxZoom: 15 });
      requestAnimationFrame(drawCrossings);
    });

    const km = route.lengthM / 1000;
    distanceMetric.textContent = `${km.toFixed(2)}km`;
    avoidMetric.textContent = `${route.danger}개`;
    statusText.textContent = `${state.start.label}에서 ${state.end.label}까지 보행 전용 경로 기준으로 ${state.targetKm}km에 가깝게 조정했습니다. 예상 횡단보도 근접 통과는 ${route.danger}곳입니다.`;
    rerouteButton.disabled = false;
  }

  function addPin(point, label, layer) {
    const icon = L.divIcon({
      className: "",
      html: '<div class="pin-marker"><span></span></div>',
      iconSize: [30, 30],
      iconAnchor: [13, 26],
      popupAnchor: [0, -24],
    });
    L.marker([point.lat, point.lng], { icon }).bindPopup(`<strong>${label}</strong><br>${point.label}`).addTo(layer);
  }

  function setBusy(isBusy) {
    primaryButton.disabled = isBusy;
  }

  function clearMetrics() {
    distanceMetric.textContent = "-";
    avoidMetric.textContent = "-";
    rerouteButton.disabled = true;
  }

  function queueMapResize() {
    requestAnimationFrame(() => {
      map.invalidateSize();
      requestAnimationFrame(() => {
        map.invalidateSize();
        drawCrossings();
      });
    });
  }

  function pathLengthMeters(points) {
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      length += distanceMeters(points[i], points[i + 1]);
    }
    return length;
  }

  function interpolate(a, b, t) {
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    };
  }

  function offsetPoint(point, bearing, meters) {
    const earth = 6378137;
    const lat1 = toRad(point.lat);
    const lng1 = toRad(point.lng);
    const angular = meters / earth;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) +
        Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
      );
    return { lat: toDeg(lat2), lng: toDeg(lng2) };
  }

  function distanceMeters(a, b) {
    const earth = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earth * Math.asin(Math.sqrt(h));
  }

  function bearingRadians(a, b) {
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(y, x);
  }

  function distancePointToSegment(point, a, b) {
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(toRad((a.lat + b.lat) / 2));
    const px = (point.lng - a.lng) * metersPerDegLng;
    const py = (point.lat - a.lat) * metersPerDegLat;
    const bx = (b.lng - a.lng) * metersPerDegLng;
    const by = (b.lat - a.lat) * metersPerDegLat;
    const lengthSq = bx * bx + by * by;
    if (lengthSq === 0) return Math.hypot(px, py);
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq));
    return Math.hypot(px - bx * t, py - by * t);
  }

  function toRad(value) {
    return (value * Math.PI) / 180;
  }

  function toDeg(value) {
    return (value * 180) / Math.PI;
  }
})();
