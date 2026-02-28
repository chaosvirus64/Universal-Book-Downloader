// Universal Book Downloader - Enhanced version with Biblioclub support
// Mod by chaosvirus64 | Based on ZnaniumDownloader by SteeaaN

async function createWorker() {
    const workerUrl = chrome.runtime.getURL("worker.js");
    const response = await fetch(workerUrl);
    let code = await response.text();

    const libs = [
        "libs/pdfkit.standalone.js",
        "libs/blob-stream.min.js",
        "libs/SVG-to-PDFKit.js",
        "libs/jszip.min.js"
    ].map(l => chrome.runtime.getURL(l));

    const header = `importScripts(${libs.map(u => `"${u}"`).join(", ")});\n`;
    const blob = new Blob([header + code], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(blob));
}

function getDecryptionKey() {
    const renderVerInput = document.querySelector('#render-ver');
    return renderVerInput.value.split(':')[0];
}

async function getBookMetadata(bookId) {
    const response = await fetch(`https://znanium.ru/catalog/document?id=${bookId}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
        }
    });
    if (!response.ok) {
        console.error('Ошибка загрузки страницы');
        return { author: 'Неизвестный автор', toc: null };
    }
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    let author = 'Неизвестный автор';
    const authorDiv = doc.querySelector('.book-link.qa_booklist_autors');
    if (authorDiv) {
        const firstAuthor = authorDiv.querySelector('a');
        if (firstAuthor) {
            author = firstAuthor.textContent.trim();
        }
    }
    let toc = null;
    const tocContainer = doc.querySelector('.book-single__headers-wrap');
    if (tocContainer) {
        toc = parseTableOfContents(tocContainer);
    }
    return { author, toc };
}

function parseTableOfContents(container) {
    function parseItems(parentElement) {
        let items = [];
        parentElement.querySelectorAll(":scope > .book-single__header-item").forEach((item) => {
            const titleElement = item.querySelector(".title");
            const pageElement = item.querySelector(".page-number");
            const subItemsContainer = item.querySelector(".subitems");
            if (titleElement && pageElement) {
                let tocItem = {
                    title: titleElement.textContent.trim(),
                    page: parseInt(pageElement.textContent.trim(), 10),
                    link: titleElement.getAttribute("href"),
                    subitems: subItemsContainer ? parseItems(subItemsContainer) : []
                };
                items.push(tocItem);
            }
        });
        return items;
    }

    return parseItems(container);
}

async function requestPage(pageNumber, bookId, format) {
    return new Promise((resolve, reject) => {
        function messageHandler(event) {
            if (event.source !== window) return;
            if (event.data.action === "pageResponse") {
                window.removeEventListener("message", messageHandler);
                resolve(event.data.page);
            } else if (event.data.action === "pageError") {
                window.removeEventListener("message", messageHandler);
                reject(new Error(event.data.error));
            }
        }
        window.addEventListener("message", messageHandler);
        window.postMessage({
            action: "getPage",
            pageNumber: pageNumber,
            bookId: bookId,
            format: format
        }, "*");
    });
}

async function fetchPage(bookId, pageNumber, format) {
    let attempts = 0;
    const maxAttempts = 25;
    while (attempts < maxAttempts) {
        try {
            let pageContent = await requestPage(pageNumber, bookId, format);
            let parser = new DOMParser();
            let xmlDoc = parser.parseFromString(pageContent, "text/xml");
            if (format === 'epub') {
                let pageTextElement = xmlDoc.querySelector("page_text");
                if (!pageTextElement?.textContent?.trim()) {
                    throw new Error("Текст страницы не найден");
                }
                return pageTextElement.textContent.trim();
            } else {
                let bookpageElement = xmlDoc.querySelector("bookpage");
                if (!bookpageElement?.textContent?.trim()) {
                    throw new Error("SVG не найден");
                }
                return bookpageElement.textContent.trim();
            }
        } catch (error) {
            console.log(`Ошибка при загрузке страницы ${pageNumber}, попытка ${attempts + 1}/${maxAttempts}:`, error);
            attempts++;
            if (attempts >= maxAttempts) {
                alert(`Не удалось загрузить страницу ${pageNumber} после ${maxAttempts} попыток`);
                setError(`Не удалось загрузить страницу ${pageNumber} после ${maxAttempts} попыток`);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
    }
}

async function downloadEPUB(startPage, endPage, bookTitle, bookId, totalPages, worker, processedPages) {
    const { author, toc } = await getBookMetadata(bookId);

    worker.postMessage({
        action: "initEPUB",
        bookTitle,
        bookId,
        author,
        toc
    });

    let downloadStopped = false;
    let allPagesQueued = false;
    let finalizeRequested = false;

    const tryFinalizeEPUB = () => {
        if (!finalizeRequested && allPagesQueued && !downloadStopped && processedPages === totalPages) {
            finalizeRequested = true;
            worker.postMessage({ action: "finalizeEPUB" });
        }
    };

    worker.onmessage = (e) => {
        if (e.data.action === "pageAdded") {
            processedPages++;
            updateProgress(Math.round((processedPages / totalPages) * 100));
            tryFinalizeEPUB();
        } else if (e.data.action === "done") {
            const blob = e.data.blob;
            const link = document.createElement("a");
            link.style.display = "none";
            document.body.appendChild(link);
            link.href = URL.createObjectURL(blob);
            link.download = sanitizeFileName(`${bookTitle}.epub`);
            link.click();
            setTimeout(() => {
                link.remove();
                URL.revokeObjectURL(link.href);
            }, 1000);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            finalizeRequested = true;
        } else if (e.data.action === "error") {
            setError(`Ошибка в воркере EPUB`);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            downloadStopped = true;
            finalizeRequested = true;
        }
    };

    for (let page = startPage; page <= endPage; page++) {
        if (downloadStopped) break;
        let pageContent = await fetchPage(bookId, page, "epub");
        if (pageContent === undefined) {
            setError(`Ошибка при скачивании страницы`);
            chrome.runtime.sendMessage({ action: "stopDownload" })
            return;
        }
        worker.postMessage({ action: "addPageEPUB", text: pageContent });
    }

    allPagesQueued = true;
    tryFinalizeEPUB();
}

async function downloadTXT(startPage, endPage, bookTitle, bookId, totalPages, processedPages) {
    let downloadStopped = false;
    let txtContent = bookTitle + "\n\n";

    chrome.runtime.onMessage.addListener(function stopListener(request) {
        if (request.action === "stopDownloadAction") {
            downloadStopped = true;
            chrome.runtime.onMessage.removeListener(stopListener);
        }
    });

    for (let page = startPage; page <= endPage; page++) {
        if (downloadStopped) break;
        let pageContent = await fetchPage(bookId, page, "epub"); // "epub" is used to fetch raw text blocks
        if (pageContent === undefined) {
            setError(`Ошибка при скачивании страницы`);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            return;
        }

        const cleanPageText = pageContent.replace(/<\/?pre[^>]*>/gi, "").trim();
        txtContent += `\n\n--- Страница ${page} ---\n\n` + cleanPageText;

        processedPages++;
        updateProgress(Math.round((processedPages / totalPages) * 100));
    }

    if (!downloadStopped) {
        const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement("a");
        link.style.display = "none";
        document.body.appendChild(link);
        link.href = URL.createObjectURL(blob);
        link.download = sanitizeFileName(`${bookTitle}.txt`);
        link.click();
        setTimeout(() => {
            link.remove();
            URL.revokeObjectURL(link.href);
        }, 1000);
        chrome.runtime.sendMessage({ action: "stopDownload" });
    }
}

async function downloadPDF(startPage, endPage, bookTitle, bookId, totalPages, worker, processedPages) {
    const decryptionKey = getDecryptionKey();
    worker.postMessage({ action: "initPDF", bookTitle, wasmUrl: chrome.runtime.getURL("decryptSVG.wasm") });

    let downloadStopped = false;
    let allPagesQueued = false;
    let finalizeRequested = false;

    const tryFinalizePDF = () => {
        if (!finalizeRequested && allPagesQueued && !downloadStopped && processedPages === totalPages) {
            finalizeRequested = true;
            worker.postMessage({ action: "finalizePDF" });
        }
    };

    worker.onmessage = (e) => {
        if (e.data.action === "pageAdded") {
            processedPages++;
            updateProgress(Math.round((processedPages / totalPages) * 100));
            tryFinalizePDF();
        } else if (e.data.action === "done") {
            finalizeRequested = true;
            const dataBuffer = e.data.buffer;
            const blob = dataBuffer ? new Blob([dataBuffer], { type: 'application/pdf' }) : e.data.blob;
            const link = document.createElement("a");
            link.style.display = "none";
            document.body.appendChild(link);
            link.href = URL.createObjectURL(blob);
            link.download = sanitizeFileName(`${bookTitle}.pdf`);
            link.click();
            setTimeout(() => {
                link.remove();
                URL.revokeObjectURL(link.href);
            }, 1000);
            chrome.runtime.sendMessage({ action: "stopDownload" });
        } else if (e.data.action === "error") {
            setError(`Ошибка при скачивании страницы`);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            downloadStopped = true;
            finalizeRequested = true;
        }
    };

    for (let page = startPage; page <= endPage; page++) {
        if (downloadStopped) break;
        let pageContent = await fetchPage(bookId, page, "pdf");
        if (pageContent === undefined) {
            setError(`Ошибка в воркере PDF`);
            chrome.runtime.sendMessage({ action: "stopDownload" })
            return;
        }
        worker.postMessage({
            action: "addPagePDF",
            svgData: pageContent,
            key: decryptionKey,
            pageNumber: page
        });
    }
    allPagesQueued = true;
    tryFinalizePDF();
}

// ============== ROUTING LOGIC ==============

async function startDownload(startPage, endPage, format) {
    const hostname = window.location.hostname;
    if (hostname.includes('znanium.ru')) {
        await startZnaniumDownload(startPage, endPage, format);
    } else if (hostname.includes('lanbook.com')) {
        await startLanbookDownload(startPage, endPage, format);
    } else if (hostname.includes('urait.ru')) {
        await startUraitDownload(startPage, endPage, format);
    } else if (hostname.includes('biblioclub.ru')) {
        await startBiblioclubDownload(startPage, endPage, format);
    } else {
        setError('Сайт не поддерживается');
    }
}

// ============== ZNANIUM LOGIC ==============

async function startZnaniumDownload(startPage, endPage, format) {
    const bookTitle = document.querySelector('p.book__name a')?.textContent.trim() || "Книга";
    const bookId = getBookIdFromURL();
    if (!bookId) {
        alert('Номер книги не найден в ссылке.');
        setError('Номер книги не найден в ссылке.');
        return;
    }
    const totalPages = endPage - startPage + 1;
    if (format === "epub" || format === "txt") {
        if (format === "txt") {
            await downloadTXT(startPage, endPage, bookTitle, bookId, totalPages, 0);
        } else {
            const worker = await createWorker();
            await downloadEPUB(startPage, endPage, bookTitle, bookId, totalPages, worker, 0);
        }
    } else {
        const worker = await createWorker();
        if (!document.querySelector('#render-ver')) {
            alert('Не найден ключ расшифровки.');
            setError('Не найден ключ расшифровки.');
            return;
        }
        await downloadPDF(startPage, endPage, bookTitle, bookId, totalPages, worker, 0);
    }
}

// ============== LANBOOK LOGIC ==============
async function startLanbookDownload(startPage, endPage, format) {
    if (format !== "pdf") {
        alert("Для Лани поддерживается только PDF");
        setError("Для Лани поддерживается только PDF");
        return;
    }

    const bookTitleElement = document.querySelector('.book-title, h1, .name');
    const bookTitle = bookTitleElement ? bookTitleElement.textContent.trim() : "Lanbook_Document";
    const totalPages = endPage - startPage + 1;

    let downloadStopped = false;
    let finalizeRequested = false;
    let processedPages = 0;

    // We can reuse the existing worker since it handles standard images/PDFs if we adapt it,
    // or we can generate a simple one. Let's assume we adapt `worker.js` or `libs/pdfkit`.
    // Znanium uses SVG decrypting. For Lanbook we just have image data.

    // Create an instance of the worker
    const worker = await createWorker();

    // Initialize PDF in worker. Lanbook does not need SVG decryption, we'll send standard images.
    // We might need to add an 'initLanbookPDF' action to worker.js to handle simple image appending.
    worker.postMessage({ action: "initLanbookPDF", bookTitle });

    const tryFinalizePDF = () => {
        if (!finalizeRequested && !downloadStopped && processedPages >= totalPages) {
            finalizeRequested = true;
            console.log("All Lanbook pages sent to worker. Finalizing...");
            worker.postMessage({ action: "finalizePDF" });
        }
    };

    worker.onmessage = (e) => {
        if (e.data.action === "pageAdded") {
            processedPages++;
            updateProgress(Math.round((processedPages / totalPages) * 100));
            tryFinalizePDF();
        } else if (e.data.action === "done") {
            finalizeRequested = true;
            const dataBuffer = e.data.buffer;
            const blob = dataBuffer ? new Blob([dataBuffer], { type: 'application/pdf' }) : e.data.blob;

            const link = document.createElement("a");
            link.style.display = "none";
            document.body.appendChild(link);
            link.href = URL.createObjectURL(blob);
            link.download = sanitizeFileName(`${bookTitle}.pdf`);
            link.click();
            setTimeout(() => {
                link.remove();
                URL.revokeObjectURL(link.href);
            }, 1000);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            worker.terminate();
        } else if (e.data.action === "error") {
            setError(`Ошибка при генерации PDF для Лани`);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            downloadStopped = true;
            finalizeRequested = true;
            worker.terminate();
        }
    };

    chrome.runtime.onMessage.addListener(function stopListener(request) {
        if (request.action === "stopDownloadAction") {
            console.log("Downloading stopped by user");
            downloadStopped = true;
            worker.terminate();
            chrome.runtime.onMessage.removeListener(stopListener);
        }
    });

    const scrollContainer = document.querySelector('#viewerContainer') || window;

    for (let page = startPage; page <= endPage; page++) {
        if (downloadStopped) break;

        const pageElement = document.querySelector(`.page[data-page-number="${page}"]`);

        if (!pageElement) {
            setError(`Страница ${page} не найдена в DOM. Убедитесь, что книга загружена.`);
            downloadStopped = true;
            break;
        }

        // Lanbook and PDF.js load visible canvases. We must scroll to it.
        pageElement.scrollIntoView({ behavior: 'auto', block: 'start' });

        // Wait a bit for the canvas to render
        await new Promise(resolve => setTimeout(resolve, 800));

        const canvas = pageElement.querySelector('canvas');

        if (!canvas) {
            setError(`Холст (canvas) для страницы ${page} не отрендерился. Попробуйте увеличить паузу.`);
            downloadStopped = true;
            break;
        }

        try {
            // Get image data
            const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
            const width = canvas.width;
            const height = canvas.height;

            worker.postMessage({
                action: "addLanbookPage",
                imageData: dataUrl,
                width: width,
                height: height,
                pageNumber: page
            });
        } catch (e) {
            console.error("Canvas error", e);
            setError(`Ошибка доступа к холсту страницы ${page}. Возможно, мешает CORS.`);
            downloadStopped = true;
            break;
        }
    }
}

// ============== URAIT LOGIC ==============
async function startUraitDownload(startPage, endPage, format) {
    if (format !== "pdf") {
        alert("Для Юрайт поддерживается только PDF");
        setError("Для Юрайт поддерживается только PDF");
        return;
    }

    const titleElement = document.querySelector('#viewer__header__title') || document.querySelector('title');
    const titleText = titleElement ? titleElement.textContent.trim() : "Urait_Document";
    const bookTitle = titleText.substring(0, 100).replace(/[<>:"/\\|?*]+/g, '_');
    const totalPages = endPage - startPage + 1;

    let downloadStopped = false;
    let finalizeRequested = false;
    let processedPages = 0;

    const worker = await createWorker();
    worker.postMessage({ action: "initLanbookPDF", bookTitle });

    const tryFinalizePDF = () => {
        if (!finalizeRequested && !downloadStopped && processedPages >= totalPages) {
            finalizeRequested = true;
            console.log("All Urait pages sent to worker. Finalizing...");
            worker.postMessage({ action: "finalizePDF" });
        }
    };

    worker.onmessage = (e) => {
        if (e.data.action === "pageAdded") {
            processedPages++;
            updateProgress(Math.round((processedPages / totalPages) * 100));
            tryFinalizePDF();
        } else if (e.data.action === "done") {
            finalizeRequested = true;
            const dataBuffer = e.data.buffer;
            const blob = dataBuffer ? new Blob([dataBuffer], { type: 'application/pdf' }) : e.data.blob;
            const link = document.createElement("a");
            link.style.display = "none";
            document.body.appendChild(link);
            link.href = URL.createObjectURL(blob);
            link.download = sanitizeFileName(`${bookTitle}.pdf`);
            link.click();
            setTimeout(() => {
                link.remove();
                URL.revokeObjectURL(link.href);
            }, 1000);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            worker.terminate();
        } else if (e.data.action === "error") {
            setError(`Ошибка при генерации PDF для Юрайт`);
            chrome.runtime.sendMessage({ action: "stopDownload" });
            downloadStopped = true;
            finalizeRequested = true;
            worker.terminate();
        }
    };

    chrome.runtime.onMessage.addListener(function stopListener(request) {
        if (request.action === "stopDownloadAction") {
            downloadStopped = true;
            worker.terminate();
            chrome.runtime.onMessage.removeListener(stopListener);
        }
    });

    const pagesList = document.querySelectorAll('.element.page');

    for (let page = startPage; page <= endPage; page++) {
        if (downloadStopped) break;

        const pageElement = pagesList[page - 1];

        if (!pageElement) {
            setError(`Страница ${page} не найдена в DOM. Убедитесь, что книга загружена.`);
            downloadStopped = true;
            break;
        }

        pageElement.scrollIntoView({ behavior: 'auto', block: 'start' });

        // Wait for Urait to render canvas
        await new Promise(resolve => setTimeout(resolve, 800));

        const canvas = pageElement.querySelector('canvas');

        if (!canvas) {
            setError(`Холст (canvas) для страницы ${page} не отрендерился. Возможно нет доступа.`);
            downloadStopped = true;
            break;
        }

        try {
            const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
            worker.postMessage({
                action: "addLanbookPage",
                imageData: dataUrl,
                width: canvas.width,
                height: canvas.height,
                pageNumber: page
            });
        } catch (e) {
            console.error("Canvas error", e);
            setError(`Ошибка доступа к холсту страницы ${page}.`);
            downloadStopped = true;
            break;
        }
    }
}

// ============== BIBLIOCLUB LOGIC ==============

async function startBiblioclubDownload(startPage, endPage, format) {
    const scripts = document.querySelectorAll('script');
    let bookInfo = null;
    let user = null;
    let svgDomain = '//viewer.biblioclub.ru';

    for (let script of scripts) {
        if (script.textContent) {
            if (script.textContent.includes('var bookInfo')) {
                const bookIdMatch = script.textContent.match(/id\s*:\s*(\d+)/);
                const pagesMatch = script.textContent.match(/pages\s*:\s*(\d+)/);
                const pageSmMatch = script.textContent.match(/page_sm\s*:\s*(\d+)/);
                if (bookIdMatch) {
                    bookInfo = {
                        id: parseInt(bookIdMatch[1]),
                        pages: pagesMatch ? parseInt(pagesMatch[1]) : 0,
                        page_sm: pageSmMatch ? parseInt(pageSmMatch[1]) : 0
                    };
                }
            }
            if (script.textContent.includes('user = {')) {
                const sessionMatch = script.textContent.match(/session\s*:\s*'([^']+)'/);
                const hlinkMatch = script.textContent.match(/hlink\s*:\s*(\d+)/);
                if (sessionMatch) {
                    user = {
                        session: sessionMatch[1],
                        hlink: hlinkMatch ? parseInt(hlinkMatch[1]) : 0
                    };
                }
            }
        }
    }

    if (!bookInfo || !user) {
        setError('Не удалось найти данные книги или сессии пользователя Biblioclub.');
        return;
    }

    let bookTitle = document.title || "Biblioclub_Book";
    bookTitle = bookTitle.replace(' - Университетская Библиотека Онлайн', '').trim();
    const totalPages = endPage - startPage + 1;
    let processedPages = 0;
    let downloadStopped = false;

    chrome.runtime.onMessage.addListener(function stopListener(request) {
        if (request.action === "stopDownloadAction") {
            downloadStopped = true;
            chrome.runtime.onMessage.removeListener(stopListener);
        }
    });

    if (format === "txt" || format === "epub") {
        let txtContent = bookTitle + "\n\n";
        let allPagesQueued = false;
        let finalizeRequested = false;
        let worker;

        if (format === "epub") {
            worker = await createWorker();
            worker.postMessage({
                action: "initEPUB",
                bookTitle,
                bookId: bookInfo.id,
                author: "Неизвестный автор",
                toc: null
            });

            const tryFinalizeEPUB = () => {
                if (!finalizeRequested && allPagesQueued && !downloadStopped && processedPages === totalPages) {
                    finalizeRequested = true;
                    worker.postMessage({ action: "finalizeEPUB" });
                }
            };

            worker.onmessage = (e) => {
                if (e.data.action === "pageAdded") {
                    processedPages++;
                    updateProgress(Math.round((processedPages / totalPages) * 100));
                    tryFinalizeEPUB();
                } else if (e.data.action === "done") {
                    const blob = e.data.blob;
                    const link = document.createElement("a");
                    link.style.display = "none";
                    document.body.appendChild(link);
                    link.href = URL.createObjectURL(blob);
                    link.download = sanitizeFileName(`${bookTitle}.epub`);
                    link.click();
                    setTimeout(() => {
                        link.remove();
                        URL.revokeObjectURL(link.href);
                    }, 1000);
                    chrome.runtime.sendMessage({ action: "stopDownload" });
                    finalizeRequested = true;
                } else if (e.data.action === "error") {
                    setError(`Ошибка в воркере EPUB`);
                    chrome.runtime.sendMessage({ action: "stopDownload" });
                    downloadStopped = true;
                    finalizeRequested = true;
                }
            };
        }

        for (let page = startPage; page <= endPage; page++) {
            if (downloadStopped) break;

            let url = `https:${svgDomain}/server.php?s=${user.session}&action=get_text&b=${bookInfo.id}&p=${bookInfo.page_sm + page}`;
            if (user.hlink > 0) {
                url += `&hlink=${user.hlink}`;
            }

            try {
                const response = await fetch(url);
                const textData = await response.json();

                let pageText = "";
                if (textData && textData.length > 0) {
                    let strs = [];
                    let y = 0;
                    let cur = '';
                    for (let i in textData) {
                        if (textData[i].y !== y) {
                            if (cur.trim() !== '') strs.push(cur.trim());
                            y = textData[i].y;
                            cur = '';
                        }
                        cur += textData[i].txt + ' ';
                    }
                    strs.push(cur.trim());
                    pageText = strs.join("\n").replace(/([а-я])-\n/ug, '$1').replace(/([а-я,])\n/ug, '$1 ').replace(/\n/g, '\n');
                }

                if (format === "txt") {
                    txtContent += `\n\n--- Страница ${page} ---\n\n` + pageText;
                    processedPages++;
                    updateProgress(Math.round((processedPages / totalPages) * 100));
                } else {
                    worker.postMessage({ action: "addPageEPUB", text: pageText });
                }
            } catch (e) {
                console.error(e);
                setError(`Ошибка загрузки текста страницы ${page}. Возможно страница состоит только из картинок.`);
                if (format === "txt") {
                    txtContent += `\n\n--- Страница ${page} ---\n\n[Не удалось извлечь текст]`;
                    processedPages++;
                    updateProgress(Math.round((processedPages / totalPages) * 100));
                } else {
                    worker.postMessage({ action: "addPageEPUB", text: "[Не удалось извлечь текст]" });
                }
            }
        }

        if (!downloadStopped) {
            if (format === "txt") {
                const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
                const link = document.createElement("a");
                link.style.display = "none";
                document.body.appendChild(link);
                link.href = URL.createObjectURL(blob);
                link.download = sanitizeFileName(`${bookTitle}.txt`);
                link.click();
                setTimeout(() => {
                    link.remove();
                    URL.revokeObjectURL(link.href);
                }, 1000);
                chrome.runtime.sendMessage({ action: "stopDownload" });
            } else {
                allPagesQueued = true;
                if (!finalizeRequested && allPagesQueued && processedPages === totalPages) {
                    finalizeRequested = true;
                    worker.postMessage({ action: "finalizeEPUB" });
                }
            }
        }
    } else {
        // PDF download
        const worker = await createWorker();
        worker.postMessage({ action: "initLanbookPDF", bookTitle });
        let finalizeRequested = false;

        const tryFinalizePDF = () => {
            if (!finalizeRequested && !downloadStopped && processedPages >= totalPages) {
                finalizeRequested = true;
                worker.postMessage({ action: "finalizePDF" });
            }
        };

        worker.onmessage = (e) => {
            if (e.data.action === "pageAdded") {
                processedPages++;
                updateProgress(Math.round((processedPages / totalPages) * 100));
                tryFinalizePDF();
            } else if (e.data.action === "done") {
                finalizeRequested = true;
                const dataBuffer = e.data.buffer;
                const blob = dataBuffer ? new Blob([dataBuffer], { type: 'application/pdf' }) : e.data.blob;
                const link = document.createElement("a");
                link.style.display = "none";
                document.body.appendChild(link);
                link.href = URL.createObjectURL(blob);
                link.download = sanitizeFileName(`${bookTitle}.pdf`);
                link.click();
                setTimeout(() => {
                    link.remove();
                    URL.revokeObjectURL(link.href);
                }, 1000);
                chrome.runtime.sendMessage({ action: "stopDownload" });
                worker.terminate();
            } else if (e.data.action === "error") {
                setError(`Ошибка при генерации PDF для Biblioclub`);
                chrome.runtime.sendMessage({ action: "stopDownload" });
                downloadStopped = true;
                finalizeRequested = true;
                worker.terminate();
            }
        };

        for (let page = startPage; page <= endPage; page++) {
            if (downloadStopped) break;

            let url = `https:${svgDomain}/server.php?s=${user.session}&action=get_page&b=${bookInfo.id}&p=${bookInfo.page_sm + page}`;
            if (user.hlink > 0) {
                url += `&hlink=${user.hlink}`;
            }

            try {
                // To fetch image data url we need to draw it to canvas
                const image = new Image();
                image.crossOrigin = "anonymous";
                const imageLoadPromise = new Promise((resolve, reject) => {
                    image.onload = () => resolve(image);
                    image.onerror = () => reject(new Error('Image load failed'));
                });
                image.src = url;

                await imageLoadPromise;

                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const ctx = canvas.getContext("2d");

                // Fill background with white to avoid black background on transparent images (e.g., SVG/PNG)
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                ctx.drawImage(image, 0, 0, image.width, image.height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.95);

                worker.postMessage({
                    action: "addLanbookPage", // Handled same as lanbook: simple JPEG pages
                    imageData: dataUrl,
                    width: canvas.width,
                    height: canvas.height,
                    pageNumber: page
                });
            } catch (e) {
                console.error(e);
                setError(`Ошибка загрузки изображения страницы ${page}.`);
                downloadStopped = true;
                break;
            }
        }
    }
}

// ============== COMMON UTILS ==============

function updateProgress(percentage) {
    chrome.runtime.sendMessage({ action: 'updateProgress', percentage });
}

function getBookIdFromURL() {
    return new URLSearchParams(window.location.search).get('id');
}

function setError(text) {
    chrome.runtime.sendMessage({
        action: 'setError',
        text: text
    });
}

function sanitizeFileName(name) {
    if (!name) return "document";
    return name.replace(/[\n\r]+/g, ' ').replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().substring(0, 120);
}

window.startDownload = startDownload;
