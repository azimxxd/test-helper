// Запоминает, куда смотрит пользователь: рядом с курсором почти всегда
// находится тот самый вопрос. Работает во всех фреймах, ничего не отправляет.
(() => {
  const save = (e) => {
    window.__thelperPointer = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  addEventListener("pointermove", save, { capture: true, passive: true });
  addEventListener("pointerdown", save, { capture: true, passive: true });
})();
