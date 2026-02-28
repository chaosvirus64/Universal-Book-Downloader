const DOWNLOAD_PENDING_TIMEOUT = 2000;
let currentDownload = null;
let pendingDownloadTimer = null;

function resetDownloadState(lockTabId) {
    if (!currentDownload) return;

    if (typeof lockTabId === "number" && typeof currentDownload.tabId === "number" && currentDownload.tabId !== lockTabId) {
        return;
    }

    const targetTabId = typeof currentDownload.tabId === "number" ? currentDownload.tabId : lockTabId;

    if (typeof targetTabId === "number") {
        try {
            chrome.action.setBadgeText({ tabId: targetTabId, text: "" }).catch(() => { });
        } catch (e) {
            // Игнорируем ошибку (например, если вкладка была закрыта и ID перестал существовать)
        }
    }

    if (pendingDownloadTimer) {
        clearTimeout(pendingDownloadTimer);
        pendingDownloadTimer = null;
    }

    currentDownload = null;
}

async function requestWakeLock() {
    try {
        chrome.power.requestKeepAwake("system");
        chrome.power.requestKeepAwake("display");
    } catch (err) {
        console.log("[Chrome Power] Ошибка:", err);
    }
}

async function releaseWakeLock() {
    try {
        chrome.power.releaseKeepAwake();
    } catch (err) {
        console.log("[Chrome Power] Ошибка:", err);
    }
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === "updateProgress") {
        if (request.percentage < 100) {
            try {
                chrome.action.setBadgeText({
                    text: request.percentage + "%",
                    tabId: sender.tab.id
                }).catch(() => { });
            } catch (e) { }
        } else {
            try {
                chrome.action.setBadgeText({
                    text: "",
                    tabId: sender.tab.id
                }).catch(() => { });
            } catch (e) { }
        }

        if (currentDownload) {
            if (!currentDownload.tabId && sender.tab?.id) {
                currentDownload.tabId = sender.tab.id;
            }
            currentDownload.lastProgress = request.percentage;
        }

        return;
    }

    if (request.action === "attemptStartDownload") {
        if (currentDownload && (currentDownload.status === "pending" || currentDownload.status === "active")) {
            sendResponse?.({ success: false, reason: "download_in_progress" });
            return;
        }

        currentDownload = {
            tabId: request.tabId ?? null,
            startPage: request.startPage,
            endPage: request.endPage,
            format: request.format,
            status: "pending",
            lastProgress: 0
        };

        if (pendingDownloadTimer) {
            clearTimeout(pendingDownloadTimer);
        }
        pendingDownloadTimer = setTimeout(() => {
            if (currentDownload && currentDownload.status === "pending") {
                resetDownloadState();
            }
        }, DOWNLOAD_PENDING_TIMEOUT);
        sendResponse?.({ success: true });
        return;
    }

    if (request.action === "getCurrentDownloadState") {
        (async () => {
            if (!currentDownload) {
                sendResponse?.({ isDownloading: false });
                return;
            }

            let badgeText = "";
            if (typeof currentDownload.tabId === "number") {
                try {
                    badgeText = await chrome.action.getBadgeText({ tabId: currentDownload.tabId });
                } catch (err) {
                    console.log("[Badge] Ошибка чтения:", err);
                }
            }

            sendResponse?.({
                isDownloading: true,
                startPage: currentDownload.startPage,
                endPage: currentDownload.endPage,
                format: currentDownload.format,
                tabId: currentDownload.tabId,
                badgeText,
                lastProgress: currentDownload.lastProgress ?? 0
            });
        })();
        return true;
    }

    if (request.action === "startDownload") {
        if (!currentDownload) {
            currentDownload = {};
        }

        currentDownload.startPage = request.startPage ?? currentDownload.startPage;
        currentDownload.endPage = request.endPage ?? currentDownload.endPage;
        currentDownload.format = request.format ?? currentDownload.format;
        if (sender.tab?.id) {
            currentDownload.tabId = sender.tab.id;
        }
        currentDownload.status = "active";
        currentDownload.lastProgress = currentDownload.lastProgress ?? 0;

        if (pendingDownloadTimer) {
            clearTimeout(pendingDownloadTimer);
            pendingDownloadTimer = null;
        }

        requestWakeLock();
        return;
    }

    if (request.action === "stopDownload") {
        releaseWakeLock();
        resetDownloadState(sender.tab?.id);
        return;
    }
});

// Removed onInstalled action.disable() to prevent locked extensions

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' && currentDownload && currentDownload.tabId === tabId) {
        releaseWakeLock();
        resetDownloadState(tabId);
    }

    if (!tab.url) return;

    const url = new URL(tab.url);
    // Always leave action enabled, popup.js will show valid/invalid site warnings gracefully.
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (currentDownload && currentDownload.tabId === tabId) {
        releaseWakeLock();
        resetDownloadState(tabId);
    }
});
