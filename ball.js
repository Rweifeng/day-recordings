const ball = document.getElementById("ball");
const tip = document.getElementById("tip");
const api = window.dayBallAPI || null;

ball.addEventListener("click", async () => {
  if (api && typeof api.showMainWindow === "function") {
    await api.showMainWindow();
  }
});

function showTip(text) {
  tip.textContent = text;
  tip.classList.add("show");
  setTimeout(() => tip.classList.remove("show"), 1100);
}

function collectDropPayload(event) {
  const dt = event.dataTransfer;
  if (!dt) {
    return { text: "", paths: [] };
  }
  const plain = String(dt.getData("text/plain") || "").trim();
  const uri = String(dt.getData("text/uri-list") || "").trim();
  const text = uri || plain;
  const paths = [];
  for (const file of Array.from(dt.files || [])) {
    if (file && typeof file.path === "string" && file.path.trim()) {
      paths.push(file.path.trim());
    }
  }
  return { text, paths };
}

["dragenter", "dragover"].forEach((name) => {
  ball.addEventListener(name, (event) => {
    event.preventDefault();
    ball.classList.add("drag-over");
  });
});

["dragleave", "dragend"].forEach((name) => {
  ball.addEventListener(name, (event) => {
    event.preventDefault();
    ball.classList.remove("drag-over");
  });
});

ball.addEventListener("drop", async (event) => {
  event.preventDefault();
  ball.classList.remove("drag-over");
  const payload = collectDropPayload(event);
  if (!api || typeof api.quickRecordDrop !== "function") {
    showTip("不可用");
    return;
  }
  const result = await api.quickRecordDrop(payload);
  showTip(result && result.ok ? `已记录 ${result.added} 条` : "未记录");
});
