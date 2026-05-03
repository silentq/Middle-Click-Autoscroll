const promiseAPI = globalThis.browser;
const callbackAPI = globalThis.chrome;
const enabledStorageKey = "isAutoscrollEnabled";

const enabledToggle = document.getElementById("enabled-toggle");

function promisify(call) {
    return new Promise((resolve, reject) => {
        call((result) => {
            const runtimeError = callbackAPI?.runtime?.lastError;

            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }

            resolve(result);
        });
    });
}

function getStorage(items) {
    if (promiseAPI?.storage?.local?.get) {
        return promiseAPI.storage.local.get(items);
    }

    return promisify((done) => callbackAPI.storage.local.get(items, done));
}

function setStorage(items) {
    if (promiseAPI?.storage?.local?.set) {
        return promiseAPI.storage.local.set(items);
    }

    return promisify((done) => callbackAPI.storage.local.set(items, done));
}

async function refreshPopupState() {
    const { [enabledStorageKey]: isEnabled = true } = await getStorage({ [enabledStorageKey]: true });
    enabledToggle.checked = isEnabled;
}

async function handleEnabledToggleChange() {
    enabledToggle.disabled = true;

    try {
        await setStorage({ [enabledStorageKey]: enabledToggle.checked });
    } finally {
        enabledToggle.disabled = false;
    }
}

enabledToggle.addEventListener("change", () => {
    handleEnabledToggleChange().catch((error) => {
        console.error(error);
        enabledToggle.checked = !enabledToggle.checked;
        enabledToggle.disabled = false;
    });
});

refreshPopupState().catch((error) => {
    console.error(error);
});
