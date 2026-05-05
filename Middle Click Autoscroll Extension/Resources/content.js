// Safari needed a few tuned deviations from Chromium's middle-click autoscroll:
// a smaller deadzone to match the visible indicator, extra onset safeguards so
// downward scrolling starts immediately, and light smoothing to reduce visible
// stepping from JS-driven scroll updates.
const INDICATOR_SIZE_PX = 34;
const INDICATOR_RADIUS_PX = INDICATOR_SIZE_PX / 2;
const MAX_SCROLL_PX_PER_SECOND = 15000;
const EDGE_THRESHOLD_PX = 24;
const EDGE_AUTO_SCROLL_PX_PER_SECOND = 16000;
const GLOBAL_AUTOSCROLL_GAIN = 1.0;
const POINTER_DISPLACEMENT_GAIN = 1.0;
const EDGE_BLEND_RANGE_PX = 42;
const AUTOSCROLL_DEADZONE_PX = 8;
const VIRTUAL_POINTER_MAX_DISTANCE_PX = 700;
const VELOCITY_SMOOTHING_PER_SECOND = 12.5;
const APPLIED_SCROLL_SMOOTHING_PER_SECOND = 14;
const MAX_QUEUED_SCROLL_PX = 250;
const MAX_TIMESTEP_MS = 50;
const DIRECTIONAL_CURSOR_THRESHOLD_PX_PER_SECOND = 1;
const INDICATOR_ACTIVE_THRESHOLD_PX_PER_SECOND = 1;
const MIN_SCROLL_PX_PER_SECOND = 35;
const SMOOTHING_BYPASS_THRESHOLD_PX_PER_SECOND = 1;
const MIN_INITIAL_SCROLL_STEP_PX = 1.2;
const SCROLL_SPEED_EXPONENT = 2.2;
const SCROLL_SPEED_MULTIPLIER = 0.00010;

const promiseAPI = globalThis.browser;
const callbackAPI = globalThis.chrome;
const extensionAPI = promiseAPI ?? callbackAPI;

const enabledStorageKey = "isAutoscrollEnabled";
const interactiveTargetSelector = [
    "a[href]",
    "area[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[contenteditable]:not([contenteditable=\"false\"])",
    "[role=\"button\"]",
    "[role=\"link\"]",
    "[data-no-autoscroll]"
].join(", ");

let isScrollLockEnabled = false;
let isAutoscrollEnabled = true;
let indicatorPosition = null;
let animationFrameID = null;
let lastAnimationTimestamp = null;
let virtualOffsetX = 0;
let virtualOffsetY = 0;
let smoothedVelocityX = 0;
let smoothedVelocityY = 0;
let smoothedAppliedScrollX = 0;
let smoothedAppliedScrollY = 0;
let pendingScrollX = 0;
let pendingScrollY = 0;
let activeScrollTarget = null;
let activeScrollAxes = { horizontal: false, vertical: true };
let isHandlingMiddleClick = false;
let scrollIndicatorHost = null;
let scrollIndicatorElements = null;

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function isPageAutoscrollEnabled() {
    return isAutoscrollEnabled;
}

function getRootScrollElement() {
    return document.scrollingElement || document.documentElement;
}

function normalizeScrollableElement(element) {
    if (!(element instanceof Element)) {
        return getRootScrollElement();
    }

    return element === document.body || element === document.documentElement
        ? getRootScrollElement()
        : element;
}

function getAxisMetrics(element, axis) {
    const target = normalizeScrollableElement(element);
    const isHorizontal = axis === "x";
    const position = isHorizontal ? target.scrollLeft : target.scrollTop;
    const maxPosition = Math.max(
        0,
        (isHorizontal ? target.scrollWidth - target.clientWidth : target.scrollHeight - target.clientHeight)
    );

    return { position, maxPosition };
}

function canScrollAlongAxis(element, axis) {
    const { maxPosition } = getAxisMetrics(element, axis);
    return maxPosition > 1;
}

function canScrollFurther(element, deltaX, deltaY) {
    const target = normalizeScrollableElement(element);

    if (deltaX !== 0) {
        const { position, maxPosition } = getAxisMetrics(target, "x");

        if ((deltaX < 0 && position > 0.5) || (deltaX > 0 && position < maxPosition - 0.5)) {
            return true;
        }
    }

    if (deltaY !== 0) {
        const { position, maxPosition } = getAxisMetrics(target, "y");

        if ((deltaY < 0 && position > 0.5) || (deltaY > 0 && position < maxPosition - 0.5)) {
            return true;
        }
    }

    return false;
}

function canScrollElement(element) {
    if (!(element instanceof Element)) {
        return false;
    }

    const target = normalizeScrollableElement(element);

    if (target === getRootScrollElement()) {
        return canScrollAlongAxis(target, "x") || canScrollAlongAxis(target, "y");
    }

    const style = window.getComputedStyle(target);
    const overflowYAllowsScroll = /(auto|scroll|overlay)/.test(style.overflowY);
    const overflowXAllowsScroll = /(auto|scroll|overlay)/.test(style.overflowX);

    return (overflowYAllowsScroll && canScrollAlongAxis(target, "y"))
        || (overflowXAllowsScroll && canScrollAlongAxis(target, "x"));
}

function getScrollableParent(element) {
    const rootScrollElement = getRootScrollElement();
    const startingElement = normalizeScrollableElement(element);

    if (startingElement === rootScrollElement) {
        return null;
    }

    let currentNode = startingElement.parentNode;

    while (currentNode) {
        if (currentNode instanceof ShadowRoot) {
            currentNode = currentNode.host;
            continue;
        }

        if (currentNode instanceof Element && canScrollElement(currentNode)) {
            return normalizeScrollableElement(currentNode);
        }

        currentNode = currentNode.parentNode;
    }

    return rootScrollElement;
}

function findScrollableContainer(startNode) {
    let currentNode = startNode instanceof Node ? startNode : null;

    while (currentNode) {
        if (currentNode instanceof Element && canScrollElement(currentNode)) {
            return normalizeScrollableElement(currentNode);
        }

        if (currentNode instanceof ShadowRoot) {
            currentNode = currentNode.host;
            continue;
        }

        currentNode = currentNode.parentNode;
    }

    return getRootScrollElement();
}

function resolveScrollTarget(event) {
    const anchoredElement = document.elementFromPoint(event.clientX, event.clientY);
    const eventTarget = event.target instanceof Node ? event.target : null;

    return findScrollableContainer(anchoredElement || eventTarget || document.body);
}

function scrollElementBy(target, deltaX, deltaY) {
    const resolvedTarget = normalizeScrollableElement(target);
    let remainingX = deltaX;
    let remainingY = deltaY;

    if (deltaX !== 0 && canScrollAlongAxis(resolvedTarget, "x")) {
        const { position, maxPosition } = getAxisMetrics(resolvedTarget, "x");
        const nextPosition = clamp(position + deltaX, 0, maxPosition);
        resolvedTarget.scrollLeft = nextPosition;
        remainingX = deltaX - (resolvedTarget.scrollLeft - position);
    }

    if (deltaY !== 0 && canScrollAlongAxis(resolvedTarget, "y")) {
        const { position, maxPosition } = getAxisMetrics(resolvedTarget, "y");
        const nextPosition = clamp(position + deltaY, 0, maxPosition);
        resolvedTarget.scrollTop = nextPosition;
        remainingY = deltaY - (resolvedTarget.scrollTop - position);
    }

    return { remainingX, remainingY };
}

function applyScrollDeltaWithChaining(startTarget, deltaX, deltaY) {
    let currentTarget = normalizeScrollableElement(startTarget);
    let remainingX = deltaX;
    let remainingY = deltaY;
    const visitedTargets = new Set();

    while (
        currentTarget
        && !visitedTargets.has(currentTarget)
        && (Math.abs(remainingX) > 0.01 || Math.abs(remainingY) > 0.01)
    ) {
        visitedTargets.add(currentTarget);

        if (canScrollFurther(currentTarget, remainingX, remainingY)) {
            const applied = scrollElementBy(currentTarget, remainingX, remainingY);
            remainingX = applied.remainingX;
            remainingY = applied.remainingY;
        }

        currentTarget = getScrollableParent(currentTarget);
    }
}

function getScrollChainAxes(target) {
    const axes = { horizontal: false, vertical: false };
    let currentTarget = normalizeScrollableElement(target);
    const visitedTargets = new Set();

    while (currentTarget && !visitedTargets.has(currentTarget)) {
        visitedTargets.add(currentTarget);
        axes.horizontal = axes.horizontal || canScrollAlongAxis(currentTarget, "x");
        axes.vertical = axes.vertical || canScrollAlongAxis(currentTarget, "y");
        currentTarget = getScrollableParent(currentTarget);
    }

    return axes;
}

function getClosestMatchingElement(startNode, selector) {
    let currentNode = startNode instanceof Node ? startNode : null;

    while (currentNode) {
        if (currentNode instanceof Element) {
            const matchingElement = currentNode.closest(selector);

            if (matchingElement) {
                return matchingElement;
            }
        }

        if (currentNode instanceof ShadowRoot) {
            currentNode = currentNode.host;
            continue;
        }

        currentNode = currentNode.parentNode;
    }

    return null;
}

function findInteractiveTarget(target) {
    return getClosestMatchingElement(target, interactiveTargetSelector);
}

function createScrollIndicator() {
    const host = document.createElement("div");
    host.setAttribute("data-middle-click-autoscroll-indicator", "true");
    host.style.position = "fixed";
    host.style.left = "0";
    host.style.top = "0";
    host.style.width = `${INDICATOR_SIZE_PX}px`;
    host.style.height = `${INDICATOR_SIZE_PX}px`;
    host.style.transform = `translate(-${INDICATOR_RADIUS_PX}px, -${INDICATOR_RADIUS_PX}px)`;
    host.style.pointerEvents = "none";
    host.style.userSelect = "none";
    host.style.webkitUserSelect = "none";
    host.style.zIndex = "2147483647";
    host.style.contain = "layout style paint";
    host.style.setProperty("--up-color", "rgba(17, 17, 17, 0.42)");
    host.style.setProperty("--down-color", "rgba(17, 17, 17, 0.42)");
    host.style.setProperty("--center-color", "rgba(17, 17, 17, 0.82)");

    const shadowRoot = host.attachShadow({ mode: "open" });

    shadowRoot.innerHTML = `
        <style>
            :host {
                all: initial;
            }

            .indicator {
                display: block;
                box-sizing: border-box;
                width: ${INDICATOR_SIZE_PX}px;
                height: ${INDICATOR_SIZE_PX}px;
                border: 1px solid rgba(0, 0, 0, 0.30);
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.98);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22);
                overflow: hidden;
            }

            svg {
                display: block;
                width: ${INDICATOR_SIZE_PX}px;
                height: ${INDICATOR_SIZE_PX}px;
            }

            .arrow-up {
                fill: var(--up-color);
            }

            .arrow-down {
                fill: var(--down-color);
            }

            .center-dot {
                fill: var(--center-color);
            }
        </style>
        <div class="indicator" aria-hidden="true">
            <svg viewBox="0 0 34 34" focusable="false">
                <path class="arrow-up" d="M17 6.2 L12.4 12.8 H15.5 V15.3 H18.5 V12.8 H21.6 Z" />
                <circle class="center-dot" cx="17" cy="17" r="3.6" />
                <path class="arrow-down" d="M17 27.8 L21.6 21.2 H18.5 V18.7 H15.5 V21.2 H12.4 Z" />
            </svg>
        </div>
    `;

    return {
        host,
        updateColors(upColor, downColor, centerColor) {
            host.style.setProperty("--up-color", upColor);
            host.style.setProperty("--down-color", downColor);
            host.style.setProperty("--center-color", centerColor);
        }
    };
}

function ensureScrollIndicator() {
    if (!scrollIndicatorElements) {
        scrollIndicatorElements = createScrollIndicator();
        scrollIndicatorHost = scrollIndicatorElements.host;
    }

    return scrollIndicatorElements;
}

function showScrollIndicator(x, y) {
    const indicator = ensureScrollIndicator();
    indicator.host.style.left = `${x}px`;
    indicator.host.style.top = `${y}px`;

    if (!indicator.host.isConnected) {
        document.documentElement.appendChild(indicator.host);
    }
}

function hideScrollIndicator() {
    scrollIndicatorHost?.remove();
}

function getArrowColor(isActive, isAvailable) {
    if (isActive) {
        return "#111111";
    }

    if (isAvailable) {
        return "rgba(17, 17, 17, 0.42)";
    }

    return "rgba(17, 17, 17, 0.14)";
}

function getDirectionalCursor(velocity) {
    const horizontalDirection = Math.abs(velocity.x) > DIRECTIONAL_CURSOR_THRESHOLD_PX_PER_SECOND
        ? Math.sign(velocity.x)
        : 0;
    const verticalDirection = Math.abs(velocity.y) > DIRECTIONAL_CURSOR_THRESHOLD_PX_PER_SECOND
        ? Math.sign(velocity.y)
        : 0;

    if (horizontalDirection === 0 && verticalDirection === 0) {
        return "default";
    }

    if (horizontalDirection === 0) {
        return verticalDirection < 0 ? "n-resize" : "s-resize";
    }

    if (verticalDirection === 0) {
        return horizontalDirection < 0 ? "w-resize" : "e-resize";
    }

    if (horizontalDirection > 0 && verticalDirection > 0) {
        return "se-resize";
    }

    if (horizontalDirection > 0 && verticalDirection < 0) {
        return "ne-resize";
    }

    if (horizontalDirection < 0 && verticalDirection > 0) {
        return "sw-resize";
    }

    return "nw-resize";
}

function updateActiveCursor(velocity = { x: 0, y: 0 }) {
    const cursor = isScrollLockEnabled ? getDirectionalCursor(velocity) : "";

    if (cursor) {
        document.documentElement.style.setProperty("cursor", cursor, "important");
        document.body?.style.setProperty("cursor", cursor, "important");
        return;
    }

    document.documentElement.style.removeProperty("cursor");
    document.body?.style.removeProperty("cursor");
}

function updateScrollIndicator(velocity = { x: 0, y: 0 }) {
    if (!scrollIndicatorElements) {
        return;
    }

    const activeY = Math.abs(velocity.y) > INDICATOR_ACTIVE_THRESHOLD_PX_PER_SECOND
        ? Math.sign(velocity.y)
        : 0;

    scrollIndicatorElements.updateColors(
        getArrowColor(activeY < 0, activeScrollAxes.vertical),
        getArrowColor(activeY > 0, activeScrollAxes.vertical),
        activeY !== 0 ? "#111111" : "rgba(17, 17, 17, 0.82)"
    );
}

function getAxisSpeed(distance, isEnabled) {
    if (!isEnabled) {
        return 0;
    }

    // Chromium normalizes by display scale before applying the autoscroll curve.
    const normalizedDistance = Math.abs(distance) / Math.max(window.devicePixelRatio || 1, 1);
    const distanceOutsideDeadzone = Math.max(0, normalizedDistance - AUTOSCROLL_DEADZONE_PX);

    if (distanceOutsideDeadzone <= 0) {
        return 0;
    }

    const curvedSpeed = Math.min(
        MAX_SCROLL_PX_PER_SECOND,
        Math.max(
            MIN_SCROLL_PX_PER_SECOND,
            Math.pow(distanceOutsideDeadzone, SCROLL_SPEED_EXPONENT) * SCROLL_SPEED_MULTIPLIER * 1000
        )
    );

    return Math.sign(distance) * curvedSpeed * GLOBAL_AUTOSCROLL_GAIN;
}

function getScrollVelocity() {
    return {
        x: getAxisSpeed(virtualOffsetX, activeScrollAxes.horizontal),
        y: getAxisSpeed(virtualOffsetY, activeScrollAxes.vertical)
    };
}

function tickScroll(timestamp) {
    if (!isScrollLockEnabled) {
        animationFrameID = null;
        lastAnimationTimestamp = null;
        return;
    }

    const deltaTimeMs = lastAnimationTimestamp === null
        ? 1000 / 60
        : Math.min(timestamp - lastAnimationTimestamp, MAX_TIMESTEP_MS);
    const deltaTimeSeconds = deltaTimeMs / 1000;
    lastAnimationTimestamp = timestamp;

    activeScrollAxes = getScrollChainAxes(activeScrollTarget || getRootScrollElement());

    const velocity = getScrollVelocity();
    const smoothingFactor = 1 - Math.exp(-VELOCITY_SMOOTHING_PER_SECOND * deltaTimeSeconds);

    if (Math.abs(smoothedVelocityX) <= SMOOTHING_BYPASS_THRESHOLD_PX_PER_SECOND && Math.abs(velocity.x) > 0) {
        smoothedVelocityX = velocity.x;
    } else {
        smoothedVelocityX += (velocity.x - smoothedVelocityX) * smoothingFactor;
    }

    if (Math.abs(smoothedVelocityY) <= SMOOTHING_BYPASS_THRESHOLD_PX_PER_SECOND && Math.abs(velocity.y) > 0) {
        smoothedVelocityY = velocity.y;
    } else {
        smoothedVelocityY += (velocity.y - smoothedVelocityY) * smoothingFactor;
    }

    updateScrollIndicator(velocity);
    updateActiveCursor(velocity);

    pendingScrollX = clamp(
        pendingScrollX + smoothedVelocityX * deltaTimeSeconds,
        -MAX_QUEUED_SCROLL_PX,
        MAX_QUEUED_SCROLL_PX
    );
    pendingScrollY = clamp(
        pendingScrollY + smoothedVelocityY * deltaTimeSeconds,
        -MAX_QUEUED_SCROLL_PX,
        MAX_QUEUED_SCROLL_PX
    );

    if (Math.abs(pendingScrollX) > 0 && Math.abs(pendingScrollX) < MIN_INITIAL_SCROLL_STEP_PX) {
        pendingScrollX = Math.sign(pendingScrollX) * MIN_INITIAL_SCROLL_STEP_PX;
    }

    if (Math.abs(pendingScrollY) > 0 && Math.abs(pendingScrollY) < MIN_INITIAL_SCROLL_STEP_PX) {
        pendingScrollY = Math.sign(pendingScrollY) * MIN_INITIAL_SCROLL_STEP_PX;
    }

    const maxAppliedScrollForFrame = MAX_SCROLL_PX_PER_SECOND * deltaTimeSeconds;
    const targetAppliedScrollX = clamp(pendingScrollX, -maxAppliedScrollForFrame, maxAppliedScrollForFrame);
    const targetAppliedScrollY = clamp(pendingScrollY, -maxAppliedScrollForFrame, maxAppliedScrollForFrame);
    const appliedScrollSmoothingFactor = 1 - Math.exp(-APPLIED_SCROLL_SMOOTHING_PER_SECOND * deltaTimeSeconds);

    smoothedAppliedScrollX += (targetAppliedScrollX - smoothedAppliedScrollX) * appliedScrollSmoothingFactor;
    smoothedAppliedScrollY += (targetAppliedScrollY - smoothedAppliedScrollY) * appliedScrollSmoothingFactor;

    const appliedScrollX = clamp(smoothedAppliedScrollX, -maxAppliedScrollForFrame, maxAppliedScrollForFrame);
    const appliedScrollY = clamp(smoothedAppliedScrollY, -maxAppliedScrollForFrame, maxAppliedScrollForFrame);

    if (Math.abs(appliedScrollX) > 0.01 || Math.abs(appliedScrollY) > 0.01) {
        applyScrollDeltaWithChaining(activeScrollTarget || getRootScrollElement(), appliedScrollX, appliedScrollY);
        pendingScrollX -= appliedScrollX;
        pendingScrollY -= appliedScrollY;
    }

    virtualOffsetX = clamp(virtualOffsetX, -VIRTUAL_POINTER_MAX_DISTANCE_PX, VIRTUAL_POINTER_MAX_DISTANCE_PX);
    virtualOffsetY = clamp(virtualOffsetY, -VIRTUAL_POINTER_MAX_DISTANCE_PX, VIRTUAL_POINTER_MAX_DISTANCE_PX);

    animationFrameID = window.requestAnimationFrame(tickScroll);
}

function ensureAnimationLoop() {
    if (animationFrameID !== null) {
        return;
    }

    lastAnimationTimestamp = null;
    animationFrameID = window.requestAnimationFrame(tickScroll);
}

function enableScrollLock(event) {
    isScrollLockEnabled = true;
    indicatorPosition = { x: event.clientX, y: event.clientY };
    virtualOffsetX = 0;
    virtualOffsetY = 0;
    smoothedVelocityX = 0;
    smoothedVelocityY = 0;
    smoothedAppliedScrollX = 0;
    smoothedAppliedScrollY = 0;
    pendingScrollX = 0;
    pendingScrollY = 0;
    activeScrollTarget = resolveScrollTarget(event);
    activeScrollAxes = getScrollChainAxes(activeScrollTarget);
    showScrollIndicator(indicatorPosition.x, indicatorPosition.y);
    updateScrollIndicator();
    updateActiveCursor();
    ensureAnimationLoop();
}

function disableScrollLock() {
    isScrollLockEnabled = false;
    indicatorPosition = null;
    virtualOffsetX = 0;
    virtualOffsetY = 0;
    smoothedVelocityX = 0;
    smoothedVelocityY = 0;
    smoothedAppliedScrollX = 0;
    smoothedAppliedScrollY = 0;
    pendingScrollX = 0;
    pendingScrollY = 0;
    activeScrollTarget = null;
    activeScrollAxes = { horizontal: false, vertical: true };
    updateActiveCursor();
    hideScrollIndicator();

    if (animationFrameID !== null) {
        window.cancelAnimationFrame(animationFrameID);
        animationFrameID = null;
    }

    lastAnimationTimestamp = null;
}

function handleMouseDown(event) {
    if (!isPageAutoscrollEnabled()) {
        return;
    }

    if (event.button === 1) {
        isHandlingMiddleClick = false;

        if (findInteractiveTarget(event.target)) {
            return;
        }

        if (!isScrollLockEnabled) {
            const candidateTarget = resolveScrollTarget(event);
            const candidateAxes = getScrollChainAxes(candidateTarget);

            if (!candidateAxes.horizontal && !candidateAxes.vertical) {
                return;
            }
        }

        isHandlingMiddleClick = true;
        event.preventDefault();
        event.stopPropagation();

        if (isScrollLockEnabled) {
            disableScrollLock();
        } else {
            enableScrollLock(event);
        }

        return;
    }

    if (isScrollLockEnabled && event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        disableScrollLock();
    }
}

function suppressMiddleClick(event) {
    if (event.button !== 1 || !isHandlingMiddleClick || findInteractiveTarget(event.target)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.type === "mouseup" || event.type === "auxclick") {
        isHandlingMiddleClick = false;
    }
}

function handleMouseUp(event) {
    if (isScrollLockEnabled && event.button === 2) {
        disableScrollLock();
    }
}

function handleMouseMove(event) {
    if (!isScrollLockEnabled || !indicatorPosition) {
        return;
    }

    virtualOffsetX = (event.clientX - indicatorPosition.x) * POINTER_DISPLACEMENT_GAIN;
    virtualOffsetY = (event.clientY - indicatorPosition.y) * POINTER_DISPLACEMENT_GAIN;

    ensureAnimationLoop();
}

function handleKeyDown(event) {
    if (isScrollLockEnabled && event.key === "Escape") {
        disableScrollLock();
    }
}

function handleVisibilityChange() {
    if (document.hidden) {
        disableScrollLock();
    }
}

function handleWheel() {
    if (isScrollLockEnabled) {
        disableScrollLock();
    }
}

function handleContextMenu() {
    if (isScrollLockEnabled) {
        disableScrollLock();
    }
}

function promisifyStorageGet(defaultValues) {
    return new Promise((resolve, reject) => {
        callbackAPI.storage.local.get(defaultValues, (items) => {
            const runtimeError = callbackAPI?.runtime?.lastError;

            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }

            resolve(items);
        });
    });
}

async function getStoredSettings() {
    const defaultValues = {
        [enabledStorageKey]: true
    };

    if (promiseAPI?.storage?.local?.get) {
        return promiseAPI.storage.local.get(defaultValues);
    }

    return promisifyStorageGet(defaultValues);
}

async function loadAutoscrollSettings() {
    try {
        const items = await getStoredSettings();
        isAutoscrollEnabled = items[enabledStorageKey] !== false;
    } catch (error) {
        isAutoscrollEnabled = true;
    }

    if (!isPageAutoscrollEnabled() && isScrollLockEnabled) {
        disableScrollLock();
    }
}

function handleStorageChanged(changes, areaName) {
    if (areaName !== "local") {
        return;
    }

    if (changes[enabledStorageKey]) {
        isAutoscrollEnabled = changes[enabledStorageKey].newValue !== false;
    }

    if (!isPageAutoscrollEnabled() && isScrollLockEnabled) {
        disableScrollLock();
    }
}

window.addEventListener("blur", disableScrollLock);
window.addEventListener("pagehide", disableScrollLock);
document.addEventListener("visibilitychange", handleVisibilityChange);
document.addEventListener("mousedown", handleMouseDown, true);
document.addEventListener("auxclick", suppressMiddleClick, true);
document.addEventListener("mouseup", suppressMiddleClick, true);
document.addEventListener("mouseup", handleMouseUp, true);
document.addEventListener("mousemove", handleMouseMove, true);
document.addEventListener("keydown", handleKeyDown, true);
document.addEventListener("contextmenu", handleContextMenu, true);
document.addEventListener("wheel", handleWheel, { capture: true, passive: true });
extensionAPI.storage?.onChanged?.addListener(handleStorageChanged);
loadAutoscrollSettings();
