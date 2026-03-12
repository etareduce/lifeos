import { dom } from "./dom.js";

let resolver = null;
let actionMap = { confirm: true, cancel: false, alt: null };
let dismissResult = false;
let lastFocusedElement = null;

function setModalActive(active) {
  if (!dom.alertModal || !dom.alertPanel) return;
  if (active) {
    lastFocusedElement = document.activeElement;
  }
  dom.alertModal.classList.toggle("active", active);
  dom.alertPanel.classList.toggle("active", active);
  dom.alertModal.setAttribute("aria-hidden", (!active).toString());
  document.body.classList.toggle("modal-open", active);
  if (!active) {
    dom.alertModal.setAttribute("inert", "");
    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  } else {
    dom.alertModal.removeAttribute("inert");
    const focusTarget = dom.alertConfirmBtn || dom.alertAltBtn || dom.alertCancelBtn;
    focusTarget?.focus();
  }
}

function closeDialog(result) {
  if (!resolver) {
    setModalActive(false);
    return;
  }
  const resolve = resolver;
  resolver = null;
  actionMap = { confirm: true, cancel: false, alt: null };
  dismissResult = false;
  setModalActive(false);
  resolve(result);
}

function configureDialog({
  title,
  message,
  confirmText,
  cancelText,
  altText,
  confirmVariant,
  altVariant,
  destructive = false,
  altDestructive = false,
  cancelDestructive = false,
  actionOrder = "cancel-alt-confirm",
}) {
  if (dom.alertTitle) dom.alertTitle.textContent = title || "Notice";
  if (dom.alertMessage) dom.alertMessage.textContent = message || "";
  if (dom.alertConfirmBtn) {
    dom.alertConfirmBtn.textContent = confirmText || "OK";
  }
  if (dom.alertCancelBtn) {
    if (cancelText) {
      dom.alertCancelBtn.textContent = cancelText;
      dom.alertCancelBtn.style.display = "";
    } else {
      dom.alertCancelBtn.style.display = "none";
    }
    dom.alertCancelBtn.classList.toggle("danger", cancelDestructive);
  }
  if (dom.alertAltBtn) {
    if (altText) {
      dom.alertAltBtn.textContent = altText;
      dom.alertAltBtn.style.display = "";
    } else {
      dom.alertAltBtn.style.display = "none";
    }
  }
  if (dom.alertConfirmBtn) {
    dom.alertConfirmBtn.classList.toggle("danger", destructive);
    dom.alertConfirmBtn.classList.toggle("ghost", confirmVariant === "ghost");
    dom.alertConfirmBtn.classList.toggle("primary", confirmVariant !== "ghost");
  }
  if (dom.alertAltBtn) {
    dom.alertAltBtn.classList.toggle("danger", altDestructive);
    dom.alertAltBtn.classList.toggle("ghost", altVariant !== "primary");
    dom.alertAltBtn.classList.toggle("primary", altVariant === "primary");
  }
  if (dom.alertPanel) {
    dom.alertPanel.dataset.actionOrder = actionOrder;
  }
}

function showDialog(options, actions, options2 = {}) {
  if (resolver) {
    closeDialog(false);
  }
  configureDialog(options);
  if (actions) {
    actionMap = actions;
  }
  dismissResult = Object.prototype.hasOwnProperty.call(options2, "dismissValue")
    ? options2.dismissValue
    : actionMap.cancel;
  setModalActive(true);
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

function confirmDialog(message, options = {}) {
  return showDialog(
    {
      title: options.title || "Confirm",
      message,
      confirmText: options.confirmText || "Confirm",
      cancelText: options.cancelText || "Cancel",
      destructive: Boolean(options.destructive),
      cancelDestructive: Boolean(options.cancelDestructive),
    },
    { confirm: true, cancel: false, alt: false },
    { dismissValue: false }
  );
}

function alertDialog(message, options = {}) {
  return showDialog(
    {
      title: options.title || "Notice",
      message,
      confirmText: options.confirmText || "OK",
      cancelText: null,
    },
    { confirm: true, cancel: true, alt: true },
    { dismissValue: true }
  );
}

function choiceDialog(message, options = {}) {
  return showDialog(
    {
      title: options.title || "Choose an action",
      message,
      confirmText: options.confirmText || "Option A",
      altText: options.altText || "Option B",
      cancelText: options.cancelText || "Cancel",
      destructive: Boolean(options.destructive),
      altDestructive: Boolean(options.altDestructive),
      cancelDestructive: Boolean(options.cancelDestructive),
      confirmVariant: options.confirmVariant,
      altVariant: options.altVariant,
      actionOrder: options.actionOrder || "cancel-alt-confirm",
    },
    {
      confirm: options.confirmValue ?? "confirm",
      alt: options.altValue ?? "alt",
      cancel: options.cancelValue ?? null,
    },
    {
      dismissValue: Object.prototype.hasOwnProperty.call(options, "dismissValue")
        ? options.dismissValue
        : (options.cancelValue ?? null),
    }
  );
}

function bindDialogEvents() {
  if (dom.alertConfirmBtn) {
    dom.alertConfirmBtn.addEventListener("click", () => closeDialog(actionMap.confirm));
  }
  if (dom.alertCancelBtn) {
    dom.alertCancelBtn.addEventListener("click", () => closeDialog(actionMap.cancel));
  }
  if (dom.alertAltBtn) {
    dom.alertAltBtn.addEventListener("click", () => closeDialog(actionMap.alt));
  }
  if (dom.alertBackdrop) {
    dom.alertBackdrop.addEventListener("click", () => closeDialog(dismissResult));
  }
  window.addEventListener("keydown", (event) => {
    if (!resolver) return;
    if (event.key === "Escape") {
      closeDialog(dismissResult);
    }
  });
}

export { alertDialog, bindDialogEvents, choiceDialog, confirmDialog };
