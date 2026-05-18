(function () {
  function seoulParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return {
      weekday: map.weekday,
      minutes: Number(map.hour) * 60 + Number(map.minute),
    };
  }

  function updateLiveState() {
    try {
      const { weekday, minutes } = seoulParts();
      const weekdayOpen = weekday !== "Sat" && weekday !== "Sun";
      const marketOpen = weekdayOpen && minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
      document.body.classList.toggle("is-kr-market-open", marketOpen);
    } catch (_) {
      document.body.classList.remove("is-kr-market-open");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateLiveState, { once: true });
  } else {
    updateLiveState();
  }
  setInterval(updateLiveState, 60 * 1000);
})();
