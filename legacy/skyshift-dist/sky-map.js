(() => {
  const {t} = window.skyPreferences;
  const NS = "http://www.w3.org/2000/svg";
  const map = document.querySelector("#celestial-map");
  const grid = map.querySelector(".sky-grid");
  const markers = map.querySelector(".sky-markers");
  const ra = document.querySelector("#sky-ra");
  const dec = document.querySelector("#sky-dec");
  const form = document.querySelector("#sky-search");
  const status = document.querySelector("#sky-status");
  let message = () => "";
  const setStatus = (next) => { message = next; status.textContent = message(); };
  const project = (a, d) => [30 + (360 - a) * 2, 14 + (90 - d) * 2];
  function add(parent, tag, attributes, label) {
    const mark = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) mark.setAttribute(key, value);
    if (label) mark.textContent = label;
    parent.append(mark);
    return mark;
  }
  for (let a = 0; a <= 360; a += 60) {
    const [x] = project(a, 0);
    add(grid, "line", {x1:x, x2:x, y1:14, y2:374});
    add(grid, "text", {x, y:396, "text-anchor":"middle"}, a + "°");
  }
  for (let d = -90; d <= 90; d += 30) {
    const [,y] = project(0, d);
    add(grid, "line", {x1:30, x2:750, y1:y, y2:y});
    add(grid, "text", {x:26, y:y+4, "text-anchor":"end"}, d + "°");
  }
  // Galactic equator in ICRS, using the standard north galactic pole.
  const radians = Math.PI / 180;
  const plane = [];
  for (let a = 360; a >= 0; a -= 1) {
    const d = Math.atan(-Math.cos(27.12825*radians) * Math.cos((a-192.85948)*radians)
      / Math.sin(27.12825*radians)) / radians;
    plane.push(project(a,d).join(","));
  }
  add(grid,"polyline",{points:plane.join(" "),class:"galactic-equator"});
  const places = [
    [269.6392,66.6331,"Кошачий Глаз","Cat’s Eye",true],
    [83.822,-5.391,"Орион","Orion","sky-orion"],
    [10.6847,41.269,"Андромеда","Andromeda"],
    [266.4051,-28.9362,"Центр Галактики","Galactic center"],
    [80.8942,-69.7561,"Тарантул","Tarantula"],
  ];
  const labels = places.map(([a,d,ru,en,example]) => {
    const [x,y] = project(a,d);
    const button = add(markers, "g", {class:"sky-place",role:"button",tabindex:0,transform:"translate("+x+" "+y+")"});
    add(button,"circle",{r:6});
    const label = add(button,"text",{x:a < 50 ? -11 : 11,y:4,"text-anchor":a < 50 ? "end" : "start"});
    function choose() {
      select(a,d);
      if (example) document.getElementById(typeof example === "string" ? example : "sky-example").click();
      else form.requestSubmit();
    }
    button.onclick = (event) => { event.stopPropagation(); choose(); };
    button.onkeydown = (event) => {
      if (["Enter"," "].includes(event.key)) { event.preventDefault(); choose(); }
    };
    return () => { label.textContent = t(ru,en); button.setAttribute("aria-label",t(ru,en)); };
  });
  const pin = add(markers, "circle", {class:"sky-pin",r:9});
  function select(a,d) {
    ra.value = a.toFixed(4);
    dec.value = d.toFixed(4);
    paint();
  }
  function paint() {
    const [x,y] = project(Number(ra.value),Number(dec.value));
    pin.setAttribute("cx",x);
    pin.setAttribute("cy",y);
  }
  select(269.6392,66.6331);
  const surface = map.querySelector(".sky-surface");
  surface.onclick = (event) => {
    const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(map.getScreenCTM().inverse());
    select(Math.min(359.9999, Math.max(0,360-(point.x-30)/2)),Math.max(-90,Math.min(90,90-(point.y-14)/2)));
    form.requestSubmit();
  };
  ra.oninput = dec.oninput = paint;
  window.skyMap = {
    select, setStatus,
    localise() { labels.forEach(update => update()); status.textContent = message(); },
  };
})();
