const deadZoneScreenFraction = 0.04;
const maximumAxisSpeed = 100;
const edgeThreshold = 24;
const edgeAutoScrollSpeed = 120;
const nominalFrameDuration = 1000 / 60;
const globalAutoscrollGain = 1.0;
const pointerDisplacementGain = 1.0;
const edgeBlendRange = 42;
const virtualPointerMaxDistance = 480;
const velocitySmoothing = 0.22;
const maximumAppliedScrollPerFrame = 100;
const queuedScrollLimit = maximumAppliedScrollPerFrame * 2.5;
const promiseAPI = globalThis.browser;
const callbackAPI = globalThis.chrome;
const extensionAPI = promiseAPI ?? callbackAPI;
const enabledStorageKey = "isAutoscrollEnabled";

let isScrollLockEnabled = false;
let isAutoscrollEnabled = true;
let scrollIndicator = null;
let indicatorPosition = null;
let animationFrameID = null;
let lastAnimationTimestamp = null;
let virtualOffsetX = 0;
let virtualOffsetY = 0;
let smoothedVelocityX = 0;
let smoothedVelocityY = 0;
let pendingScrollX = 0;
let pendingScrollY = 0;
let activeScrollTarget = null;
let activeScrollAxes = { horizontal: false, vertical: true };
let isHandlingMiddleClick = false;

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function getRootScrollElement() {
    return document.scrollingElement || document.documentElement;
}

function canScrollElement(element) {
    if (!(element instanceof Element)) {
        return false;
    }

    const rootScrollElement = getRootScrollElement();

    if (element === rootScrollElement || element === document.body || element === document.documentElement) {
        return rootScrollElement.scrollHeight > rootScrollElement.clientHeight + 1
            || rootScrollElement.scrollWidth > rootScrollElement.clientWidth + 1;
    }

    const style = window.getComputedStyle(element);
    const overflowYAllowsScroll = /(auto|scroll|overlay)/.test(style.overflowY);
    const overflowXAllowsScroll = /(auto|scroll|overlay)/.test(style.overflowX);

    return (overflowYAllowsScroll && element.scrollHeight > element.clientHeight + 1)
        || (overflowXAllowsScroll && element.scrollWidth > element.clientWidth + 1);
}

function findScrollableContainer(startNode) {
    let currentNode = startNode instanceof Node ? startNode : null;

    while (currentNode) {
        if (currentNode instanceof Element && canScrollElement(currentNode)) {
            return currentNode === document.body || currentNode === document.documentElement
                ? getRootScrollElement()
                : currentNode;
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

function applyScrollDelta(deltaX, deltaY) {
    const target = activeScrollTarget || getRootScrollElement();

    if (target === getRootScrollElement()) {
        target.scrollLeft += deltaX;
        target.scrollTop += deltaY;
        return;
    }

    target.scrollLeft += deltaX;
    target.scrollTop += deltaY;
}

function createScrollIndicator() {
    const indicator = document.createElement("div");
    indicator.setAttribute("data-scroll-lock-indicator", "true");
    indicator.style.position = "fixed";
    indicator.style.width = "34px";
    indicator.style.height = "34px";
    indicator.style.marginLeft = "-17px";
    indicator.style.marginTop = "-17px";
    indicator.style.border = "1px solid rgba(0, 0, 0, 0.30)";
    indicator.style.borderRadius = "50%";
    indicator.style.background = "rgba(255, 255, 255, 0.98)";
    indicator.style.boxShadow = "0 1px 4px rgba(0, 0, 0, 0.22)";
    indicator.style.pointerEvents = "none";
    indicator.style.zIndex = "2147483647";
    indicator.style.userSelect = "none";
    indicator.style.webkitUserSelect = "none";
    indicator.style.overflow = "hidden";
    return indicator;
}

function showScrollIndicator(x, y) {
    if (!scrollIndicator) {
        scrollIndicator = createScrollIndicator();
    }

    scrollIndicator.style.left = `${x}px`;
    scrollIndicator.style.top = `${y}px`;

    if (!scrollIndicator.isConnected) {
        document.documentElement.appendChild(scrollIndicator);
    }
}

function hideScrollIndicator() {
    scrollIndicator?.remove();
}

function getScrollTargetAxes(target) {
    const resolvedTarget = target || getRootScrollElement();
    const isRootTarget = resolvedTarget === getRootScrollElement();
    const clientWidth = isRootTarget ? window.innerWidth : resolvedTarget.clientWidth;
    const clientHeight = isRootTarget ? window.innerHeight : resolvedTarget.clientHeight;

    return {
        horizontal: resolvedTarget.scrollWidth > clientWidth + 1,
        vertical: resolvedTarget.scrollHeight > clientHeight + 1
    };
}

function hasScrollableAxis(axes) {
    return axes.horizontal || axes.vertical;
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
    const threshold = 0.1;
    const horizontalDirection = Math.abs(velocity.x) > threshold ? Math.sign(velocity.x) : 0;
    const verticalDirection = Math.abs(velocity.y) > threshold ? Math.sign(velocity.y) : 0;

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
    if (!scrollIndicator) {
        return;
    }

    const activeY = Math.abs(velocity.y) > 0.1 ? Math.sign(velocity.y) : 0;

    const upColor = getArrowColor(activeY < 0, true);
    const downColor = getArrowColor(activeY > 0, true);
    const centerColor = activeY !== 0 ? "#111111" : "rgba(17, 17, 17, 0.82)";

    scrollIndicator.innerHTML = `
        <svg viewBox="0 0 34 34" width="34" height="34" aria-hidden="true">
            <path d="M17 6.2 L12.4 12.8 H15.5 V15.3 H18.5 V12.8 H21.6 Z" fill="${upColor}" />
            <circle cx="17" cy="17" r="3.6" fill="${centerColor}" />
            <path d="M17 27.8 L21.6 21.2 H18.5 V18.7 H15.5 V21.2 H12.4 Z" fill="${downColor}" />
        </svg>
    `;
}

function getAxisSpeed(distance, viewportSize, isEnabled) {
    if (!isEnabled) {
        return 0;
    }

    const normalizedDistance = Math.abs(distance) / Math.max(1, viewportSize);

    if (normalizedDistance <= deadZoneScreenFraction) {
        return 0;
    }

    const effectivePercentage = normalizedDistance - deadZoneScreenFraction;
    const linearSpeed = Math.min(maximumAxisSpeed, effectivePercentage * maximumAxisSpeed * 2);

    return Math.sign(distance) * linearSpeed * globalAutoscrollGain;
}

function getScrollVelocity() {
    const baseVelocity = {
        x: getAxisSpeed(virtualOffsetX, window.innerWidth, activeScrollAxes.horizontal),
        y: getAxisSpeed(virtualOffsetY, window.innerHeight, activeScrollAxes.vertical)
    };

    const pointerX = indicatorPosition.x + virtualOffsetX;
    const pointerY = indicatorPosition.y + virtualOffsetY;

    const leftBlend = Math.max(0, Math.min(1, (edgeThreshold + edgeBlendRange - pointerX) / edgeBlendRange));
    const rightBlend = Math.max(0, Math.min(1, (pointerX - (window.innerWidth - edgeThreshold - edgeBlendRange)) / edgeBlendRange));
    const topBlend = Math.max(0, Math.min(1, (edgeThreshold + edgeBlendRange - pointerY) / edgeBlendRange));
    const bottomBlend = Math.max(0, Math.min(1, (pointerY - (window.innerHeight - edgeThreshold - edgeBlendRange)) / edgeBlendRange));

    const edgeVelocityX = leftBlend > 0
        ? -edgeAutoScrollSpeed * globalAutoscrollGain
        : rightBlend > 0
            ? edgeAutoScrollSpeed * globalAutoscrollGain
            : baseVelocity.x;

    const edgeVelocityY = topBlend > 0
        ? -edgeAutoScrollSpeed * globalAutoscrollGain
        : bottomBlend > 0
            ? edgeAutoScrollSpeed * globalAutoscrollGain
            : baseVelocity.y;

    const blendX = Math.max(leftBlend, rightBlend);
    const blendY = Math.max(topBlend, bottomBlend);

    return {
        x: baseVelocity.x + (edgeVelocityX - baseVelocity.x) * blendX,
        y: baseVelocity.y + (edgeVelocityY - baseVelocity.y) * blendY
    };
}

function tickScroll(timestamp) {
    if (!isScrollLockEnabled) {
        animationFrameID = null;
        lastAnimationTimestamp = null;
        return;
    }

    const deltaTime = lastAnimationTimestamp === null
        ? nominalFrameDuration
        : Math.min(timestamp - lastAnimationTimestamp, nominalFrameDuration * 2);
    const frameScale = deltaTime / nominalFrameDuration;
    lastAnimationTimestamp = timestamp;

    const velocity = getScrollVelocity();
    smoothedVelocityX += (velocity.x - smoothedVelocityX) * velocitySmoothing;
    smoothedVelocityY += (velocity.y - smoothedVelocityY) * velocitySmoothing;
    updateScrollIndicator({ x: smoothedVelocityX, y: smoothedVelocityY });
    updateActiveCursor({ x: smoothedVelocityX, y: smoothedVelocityY });

    pendingScrollX = clamp(
        pendingScrollX + smoothedVelocityX * frameScale,
        -queuedScrollLimit,
        queuedScrollLimit
    );
    pendingScrollY = clamp(
        pendingScrollY + smoothedVelocityY * frameScale,
        -queuedScrollLimit,
        queuedScrollLimit
    );

    const appliedScrollX = clamp(pendingScrollX, -maximumAppliedScrollPerFrame, maximumAppliedScrollPerFrame);
    const appliedScrollY = clamp(pendingScrollY, -maximumAppliedScrollPerFrame, maximumAppliedScrollPerFrame);

    if (Math.abs(appliedScrollX) > 0.01 || Math.abs(appliedScrollY) > 0.01) {
        applyScrollDelta(appliedScrollX, appliedScrollY);
        pendingScrollX -= appliedScrollX;
        pendingScrollY -= appliedScrollY;
    }

    virtualOffsetX = clamp(virtualOffsetX, -virtualPointerMaxDistance, virtualPointerMaxDistance);
    virtualOffsetY = clamp(virtualOffsetY, -virtualPointerMaxDistance, virtualPointerMaxDistance);

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
    pendingScrollX = 0;
    pendingScrollY = 0;
    activeScrollTarget = resolveScrollTarget(event);
    activeScrollAxes = getScrollTargetAxes(activeScrollTarget);
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

function findHyperlinkTarget(target) {
    if (!(target instanceof Element)) {
        return null;
    }

    return target.closest("a[href], area[href]");
}

function handleMouseDown(event) {
    if (!isAutoscrollEnabled) {
        return;
    }

    if (event.button === 1) {
        isHandlingMiddleClick = false;

        if (findHyperlinkTarget(event.target)) {
            return;
        }

        if (!isScrollLockEnabled) {
            const candidateTarget = resolveScrollTarget(event);
            const candidateAxes = getScrollTargetAxes(candidateTarget);

            if (!hasScrollableAxis(candidateAxes)) {
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
        return;
    }

}

function suppressMiddleClick(event) {
    if (event.button !== 1 || !isHandlingMiddleClick || findHyperlinkTarget(event.target)) {
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
    if (!isScrollLockEnabled) {
        return;
    }

    virtualOffsetX = (event.clientX - indicatorPosition.x) * pointerDisplacementGain;
    virtualOffsetY = (event.clientY - indicatorPosition.y) * pointerDisplacementGain;

    ensureAnimationLoop();
}

function handleKeyDown(event) {
    if (isScrollLockEnabled && event.key === "Escape") {
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

async function loadAutoscrollEnabledState() {
    try {
        if (promiseAPI?.storage?.local?.get) {
            const items = await promiseAPI.storage.local.get({ [enabledStorageKey]: true });
            isAutoscrollEnabled = items[enabledStorageKey] !== false;
            return;
        }

        const items = await promisifyStorageGet({ [enabledStorageKey]: true });
        isAutoscrollEnabled = items[enabledStorageKey] !== false;
    } catch (error) {
        isAutoscrollEnabled = true;
    }
}

function handleStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes[enabledStorageKey]) {
        return;
    }

    isAutoscrollEnabled = changes[enabledStorageKey].newValue !== false;

    if (!isAutoscrollEnabled && isScrollLockEnabled) {
        disableScrollLock();
    }
}

window.addEventListener("blur", disableScrollLock);
document.addEventListener("mousedown", handleMouseDown, true);
document.addEventListener("auxclick", suppressMiddleClick, true);
document.addEventListener("mouseup", suppressMiddleClick, true);
document.addEventListener("mouseup", handleMouseUp, true);
document.addEventListener("mousemove", handleMouseMove, true);
document.addEventListener("keydown", handleKeyDown, true);
extensionAPI.storage?.onChanged?.addListener(handleStorageChanged);
loadAutoscrollEnabledState();
