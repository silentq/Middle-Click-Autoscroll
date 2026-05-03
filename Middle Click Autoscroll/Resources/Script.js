function showInstallState() {
    document.body.classList.remove("state-on");
    document.body.classList.remove("state-off");
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
