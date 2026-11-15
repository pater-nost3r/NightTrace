(() => {
  const labels = {
  "Карта всего неба": "All-sky map",
  "Нажмите на карту или введите координаты, чтобы сравнить снимки SPHEREx за разные даты.": "Click the map or enter coordinates to compare SPHEREx observations from different dates.",
  "Найти снимки": "Find observations",
  "Пример: Кошачий Глаз": "Example: Cat’s Eye",
  "Пример: Орион": "Example: Orion",
  "Сравнение снимков неба SPHEREx · независимый проект на открытых данных NASA/IPAC": "Compare SPHEREx images · an independent project using NASA/IPAC data",
  "Пауза": "Pause",
  "Просмотр неба": "Sky viewer",
  "Область неба": "Sky field",
  "Загрузка данных…": "Loading observations…",
  "Один и тот же участок неба в разное время. Переключайте кадры и ищите, что изменилось.": "View the same patch of sky at different times. Switch frames to look for changes.",
  "Координаты центра": "Field center coordinates",
  "Диапазон": "Band",
  "Снимок неба. Перетаскивайте для сдвига, колесо или щипок для увеличения.": "Sky image. Drag to pan. Use the wheel or zoom buttons to zoom.",
  "Положение ползунка сравнения": "Comparison slider position",
  "Масштаб": "Zoom",
  "Приблизить (+)": "Zoom in (+)",
  "Приблизить": "Zoom in",
  "Отдалить (−)": "Zoom out (−)",
  "Отдалить": "Zoom out",
  "Вписать (0)": "Fit (0)",
  "Вписать целиком": "Fit image",
  "Обновить снимки из архива": "Refresh from archive",
  "Способ сравнения": "Comparison mode",
  "Один кадр (1)": "Single frame (1)",
  "Кадр": "Frame",
  "Мигание A↔B (2)": "Blink A↔B (2)",
  "Мигание": "Blink",
  "Ползунок": "Slider",
  "Временная шкала": "Timeline",
  "Время наблюдения ·": "Observation time ·",
  "Предыдущий кадр (←)": "Previous frame (←)",
  "Предыдущий кадр": "Previous frame",
  "Проиграть": "Play",
  "Следующий кадр (→)": "Next frame (→)",
  "Следующий кадр": "Next frame",
  "Скорость": "Speed",
  "Скорость проигрывания": "Playback speed",
  "Пробел": "Space",
  "пуск ·": "play ·",
  "кадры ·": "frames ·",
  "режимы": "modes",
  "Как смотреть": "How to use",
  "Кадры": "Frames",
  "Данные наблюдения": "Observation data",
  "Ограничения": "Limitations",
  "Осмотрите область.": "Explore the field.",
  "Перетаскивайте снимок, приближайте колесом мыши, щипком или кнопкой «+».": "Drag the image to pan. Use the mouse wheel or the + button to zoom.",
  "Выберите время.": "Choose a time.",
  "Нажмите на отметку на шкале — это момент съёмки кадра.": "Select a marker on the timeline to show that observation.",
  "Сравните кадры.": "Compare frames.",
  "«Мигание» быстро чередует A и B, «Ползунок» делит экран пополам. Если точка сдвинулась или изменила яркость, это будет заметно.": "Blink alternates between A and B. Slider shows the two images side by side so you can look for shifts or changes in brightness.",
  "Соседние экспозиции SPHEREx идут с шагом": "The first two SPHEREx exposures are separated by",
  "129 секунд": "129 seconds",
  "(первые два кадра здесь). За это время почти ничто на небе заметно не сдвигается, и видимые различия обычно дают шум детектора, следы частиц и края кадра.": "in this set. Differences on this timescale usually come from detector noise, particle tracks, or frame edges.",
  "Остальные кадры разделены неделями и месяцами (весь охват —": "Later observations span",
  "). SPHEREx снимает через фильтр с переменной длиной волны, поэтому в каждом визите объект виден на чуть другой длине волны (λ в углу снимка). Разница в яркости может объясняться этим, а не изменением самого объекта.": ". SPHEREx uses a variable wavelength filter. Differences in wavelength (λ in the viewer) can change how bright sources appear.",
  "Инструмент только показывает настоящие снимки рядом. Он": "This viewer compares real observations. It",
  "не обнаруживает движение автоматически": "does not detect motion automatically",
  "и не находит новые планеты. Любую находку нужно проверять по оригинальным данным.": "or identify new planets. Check candidates against the original data.",
  "Независимый образовательный проект для хакатона 2026. Не является сайтом NASA и не связан с ним. Снимки: миссия SPHEREx, архив NASA/IPAC Infrared Science Archive (IRSA). Изображения показаны без изменений цвета.": "Independent educational project for the 2026 hackathon. Grayscale images from the SPHEREx mission, courtesy of the NASA/IPAC Infrared Science Archive (IRSA).",
  "Тема": "Theme",
  "Язык": "Language",
  "Системная": "System",
  "Светлая": "Light",
  "Тёмная": "Dark",
  "FITS-вырезка на IRSA": "FITS cutout at IRSA",
  "Полный файл на IRSA": "Full FITS at IRSA",
  "Копия на AWS": "AWS copy",
  "Проверяем архив NASA/IPAC. Это может занять пару минут.": "Checking the NASA/IPAC archive. This may take a couple of minutes.",
  "Более свежих сопоставимых кадров не найдено.": "No newer comparable frames found.",
  "Обновление недоступно. Сохранённые снимки можно просматривать.": "Refresh is unavailable. Saved images are still available.",
  "Проверка архива уже идёт.": "An archive refresh is already running.",
  "Не удалось обновить кадры из архива. Сохранённая подборка доступна.": "Could not refresh from the archive. Saved images are still available.",
  "Не удалось загрузить данные": "Could not load observations",
  "Откройте страницу через локальный сервер.": "Open this page through the local server.",
  "Нет кадров": "No frames",
  "В manifest.json не найден список кадров.": "No frames were listed in the manifest.",
  "Снимок не загрузился": "Image failed to load",
  "Область неба SPHEREx": "SPHEREx sky field",
  "небольшой промежуток времени": "a short time",
  "Центр RA": "Center RA",
  "Центр Dec": "Center Dec",
  "Кадров": "Frames",
  "Поле, угл. мин": "Field, arcmin",
  "Пиксель, угл. с": "Pixel, arcsec",
  "Выпуск данных": "Data release",
  "Детектор": "Detector",
  "Показать": "Show",
  "Сравнивать с этим кадром (B)": "Compare with this frame (B)",
  "Источник": "Source",
  "Источник данных": "Data source",
  "SPHEREx: доступ к данным (IRSA)": "SPHEREx data access (IRSA)",
  "Облачная копия архива (AWS Open Data)": "Cloud archive (AWS Open Data)",
  "КАДР": "FRAME",
  "Оригиналы показанного кадра": "Original files for the displayed frame",
  "Мигать": "Blink",
  "Проигрывание": "Playing",
  "КУРСОР": "CURSOR",
  "ЦЕНТР": "CENTER",
  "Ползунок A|B (3)": "Slider A|B (3)",
  "Выберите другой кадр.": "Choose another frame."
};
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  function read(key) {
    try { return localStorage.getItem("skyshift." + key); } catch { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem("skyshift." + key, value); } catch { /* Optional persistence. */ }
  }
  const auto = window.skyAutoLanguages;
  const languages = [...auto.builtIn, ...auto.codes];
  const savedLanguage = read("language");
  const state = {
    language: auto.builtIn.includes(savedLanguage) ? savedLanguage : "ru",
    theme: ["dark", "light"].includes(read("theme")) ? read("theme") : "system",
  };
  function applyTheme() {
    const theme = state.theme === "system" ? (system.matches ? "dark" : "light") : state.theme;
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#08090B" : "#F6F7FA";
  }
  applyTheme();
  system.addEventListener("change", applyTheme);

  function t(ru, en) {
    if (state.language === "ru") return ru;
    const english = en ?? labels[ru] ?? ru;
    if (state.language === "es") return window.skySpanish[english] ?? english;
    return auto.translate(state.language, english);
  }
  function bind(onLanguageChange) {
    const bindings = [];
    const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = nodes.nextNode());) {
      const current = node;
      const value = current.nodeValue;
      const key = value.trim();
      if (Object.hasOwn(labels, key)) bindings.push(() => { current.nodeValue = value.replace(key, t(key)); });
    }
    for (const element of document.querySelectorAll("[aria-label], [title]")) {
      for (const attribute of ["aria-label", "title"]) {
        const key = element.getAttribute(attribute);
        if (Object.hasOwn(labels, key)) bindings.push(() => element.setAttribute(attribute, t(key)));
      }
    }
    const theme = document.querySelector("#theme-pref");
    const language = document.querySelector("#language-pref");
    const extra = auto.bind(language, document.querySelector("#language-status"), code => {
      state.language = code;
      applyLanguage();
      onLanguageChange();
    });
    function applyLanguage() {
      root.lang = state.language;
      root.dir = auto.rtl.has(state.language) ? "rtl" : "ltr";
      document.title = t("SkyShift — сравнение кадров SPHEREx", "SkyShift — compare SPHEREx images");
      document.querySelector('meta[name="description"]').content = t(
        "Инструмент для сравнения снимков SPHEREx на открытых данных NASA/IPAC IRSA.",
        "Compare SPHEREx images from the NASA/IPAC IRSA archive.",
      );
      bindings.forEach(update => update());
      extra.showHelp(t);
    }
    theme.value = state.theme;
    language.value = state.language;
    applyLanguage();
    theme.addEventListener("change", () => {
      state.theme = theme.value;
      save("theme", state.theme);
      applyTheme();
    });
    language.addEventListener("change", () => {
      save("language", language.value);
      void extra.change(language.value, t);
    });
    document.querySelector("#translate-interface").onclick = () => void extra.retry(t);
    if (languages.includes(savedLanguage) && !auto.builtIn.includes(savedLanguage)) {
      // The viewer binds its controls immediately after this function returns.
      queueMicrotask(() => void extra.change(savedLanguage, t, true));
    }
  }
  window.skyPreferences = { state, t, bind };
})();
