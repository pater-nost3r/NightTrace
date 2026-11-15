(() => {
  // Language packs supported by the browser Translator API.
  const codes = "ar bg bn cs da de el fi fr he hi hr hu id it ja kn ko lt mr nl no pl pt ro sk sl sv ta te th tr uk vi zh zh-Hant".split(" ");
  const builtIn = ["ru", "en", "es"];
  const rtl = new Set(["ar", "he"]);
  let active;

  function readCache(code) {
    try {
      return new Map(Object.entries(JSON.parse(localStorage.getItem("skyshift.translation.v1." + code) || "{}")));
    } catch {
      return new Map();
    }
  }

  function bind(select, status, apply) {
    const button = document.querySelector("#translate-interface");
    const help = document.querySelector("#translation-help");
    const labels = codes.map(code => [code, new Intl.DisplayNames(code, {type:"language"}).of(code)]);
    const group = document.createElement("optgroup");
    for (const [code, label] of labels.sort((a,b) => a[1].localeCompare(b[1]))) {
      const option = new Option(label, code);
      option.lang = code;
      group.append(option);
    }
    select.append(group);
    function showHelp(t) {
      group.label = t("Автоматический перевод", "Automatic translation");
      button.textContent = t("Перевести", "Translate");
      help.textContent = t("Перевод в браузере", "Browser translation");
    }

    async function change(code, t, restore = false) {
      active?.controller.abort();
      active = null;
      button.hidden = true;
      help.hidden = true;
      status.textContent = "";
      if (builtIn.includes(code)) {
        apply(code);
        return;
      }
      const job = {code, cache: readCache(code), controller: new AbortController(), pending: new Set(), failed: new Set(),
        apply: () => apply(code), notify: (ru, en) => { status.textContent = t(ru, en); }};
      active = job;
      apply(job.cache.size ? code : "en");
      select.value = code;
      const api = window.Translator;
      const options = {sourceLanguage:"en", targetLanguage:code};
      if (!api) {
        help.hidden = false;
        job.notify("Для этого языка используйте перевод страницы в браузере.",
          "Use your browser’s page translation for this language.");
        return;
      }
      try {
        const availability = await api.availability(options);
        if (active !== job) return;
        if (availability === "unavailable") {
          help.hidden = false;
          job.notify("Этот язык недоступен для встроенного перевода. Попробуйте перевод страницы в браузере.",
            "This language is unavailable for in-app translation. Try your browser’s page translation.");
          return;
        }
        if (restore && availability !== "available") {
          button.hidden = false;
          job.notify("Нажмите «Перевести», чтобы загрузить языковой пакет.",
            "Select Translate to download the language pack.");
          return;
        }
        job.notify("Готовим автоматический перевод…", "Preparing automatic translation…");
        job.translator = await api.create({...options, signal:job.controller.signal});
        if (active !== job) return;
        apply(code);
        button.hidden = true;
      } catch {
        if (active !== job) return;
        button.hidden = false;
        help.hidden = false;
        job.notify("Не удалось запустить перевод. Повторите попытку или используйте перевод страницы в браузере.",
          "Could not start translation. Retry or use your browser’s page translation.");
      }
    }
    return {showHelp, change, retry(t) { return change(select.value, t); }};
  }

  async function translateBatch(job) {
    while (active === job && job.pending.size) {
      const batch = [...job.pending];
      job.pending.clear();
      for (const text of batch) {
        if (active !== job) return;
        try {
          const translated = await job.translator.translate(text, {signal:job.controller.signal});
          // Keep translated interface strings safe in existing HTML templates.
          const safe = translated.replace(/[<>"&]/g, c => ({"<":"‹",">":"›",'"':"”","&":"＆"})[c]);
          job.cache.set(text, safe.trim() || text);
        } catch {
          if (active !== job) return;
          job.failed.add(text);
          job.partial = true;
        }
      }
      if (active !== job) return;
      try {
        localStorage.setItem("skyshift.translation.v1." + job.code, JSON.stringify(Object.fromEntries(job.cache)));
      } catch { /* Translation is usable without storage. */ }
      job.apply();
    }
    if (active === job) {
      job.notify(job.partial ? "Часть текста осталась на английском." : "",
        job.partial ? "Some text remains in English." : "");
    }
    job.running = false;
  }

  function translate(code, english) {
    const job = active;
    if (job?.code !== code) return english;
    if (job.cache.has(english)) return job.cache.get(english);
    if (job.translator && !job.failed.has(english) && /[a-z]{2}/i.test(english)) {
      job.pending.add(english);
      if (!job.running) {
        job.running = true;
        queueMicrotask(() => void translateBatch(job));
      }
    }
    return english;
  }

  window.skyAutoLanguages = {codes, builtIn, rtl, bind, translate};
})();
