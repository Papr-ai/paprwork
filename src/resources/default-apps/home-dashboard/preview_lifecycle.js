/** Pause background work when Paprwork backgrounds this preview tab. */
(function () {
  var phase = "visible";
  window.PaprPreview = {
    phase: function () {
      return phase;
    },
    isVisible: function () {
      return phase === "visible";
    },
    onPhase: function (listener) {
      listener(phase);
      var handler = function (event) {
        var type = event.data && event.data.type;
        if (type === "papr:preview-hidden") {
          phase = "hidden";
          listener(phase);
        } else if (type === "papr:preview-visible") {
          phase = "visible";
          listener(phase);
        } else if (type === "papr:preview-evicting") {
          phase = "evicting";
          listener(phase);
        }
      };
      window.addEventListener("message", handler);
      return function () {
        window.removeEventListener("message", handler);
      };
    },
  };
  window.addEventListener("message", function (event) {
    var type = event.data && event.data.type;
    if (type === "papr:preview-hidden") {
      phase = "hidden";
    } else if (type === "papr:preview-visible") {
      phase = "visible";
    } else if (type === "papr:preview-evicting") {
      phase = "evicting";
    }
  });
})();
