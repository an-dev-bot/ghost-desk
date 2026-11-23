// Phone notifications through the service worker (required on Android; on iPhone only when the app is
// installed on the home screen with iOS 16.4+). No push server: they fire while the app is open or
// recently sent to the background.

export function notifySupport() {
  if (!("Notification" in window)) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return { ok: false, why: ios ? "On iPhone, notifications only work with the app added to the Home Screen (iOS 16.4 or later)." : "This browser does not allow notifications." };
  }
  return { ok: true, permission: Notification.permission };
}

export async function askPermission() {
  if (!("Notification" in window)) return "unsupported";
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** Show a phone notification if allowed. Returns true if shown. */
export async function notify(title, body, { tag, url = "./" } = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const opts = { body, tag, renotify: !!tag, icon: "icons/icon-192.png", badge: "icons/badge-96.png", data: { url } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return true; }
    new Notification(title, opts);
    return true;
  } catch { return false; }
}
