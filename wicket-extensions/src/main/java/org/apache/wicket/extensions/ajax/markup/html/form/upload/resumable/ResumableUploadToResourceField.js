/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * The script of ResumableUploadToResourceField: a Wicket.FileUploadToResourceField that sends each
 * file in chunks over the tus protocol 1.0 (https://tus.io/protocols/resumable-upload).
 */
;(function (undefined) {

    'use strict';

    if (typeof(Wicket.ResumableUploadToResourceField) === 'function') {
        return;
    }

    const TUS_RESUMABLE = '1.0.0';
    const CHUNK_TYPE = 'application/offset+octet-stream';
    const FILE_NAME_HEADER = 'Wicket-Upload-File-Name';
    const ERROR_HEADER = 'Wicket-Upload-Error';
    const STORAGE_PREFIX = 'wicket-resumable-upload::';

    // the keys of the errors, as the field knows them
    const NO_FILE_SELECTED = 'wicket.no.files.selected';
    const UPLOAD_FAILED = 'uploadFailed';
    const CONNECTION_LOST = 'uploadConnectionLost';
    const UPLOAD_CANCELED = 'upload.canceled';
    const UPLOAD_LOST = 'resumableUploadLost';

    // how long to wait before each new attempt after a failed request
    const RETRY_DELAYS = [0, 1000, 3000, 5000, 10000, 20000];

    // how long a chunk may send nothing before the request is given up as stalled
    const STALL_MILLIS = 30000;

    // the uploads of the fields, by field id, which a new rendering of a field takes over
    const uploadsOf = Object.create(null);

    let lastKey = 0;

    const Base = Wicket.FileUploadToResourceField;

    /**
     * @param settings the settings of Wicket.FileUploadToResourceField, with chunkSize,
     *        parallelUploads, remembering and texts
     */
    const Field = Wicket.ResumableUploadToResourceField = function (settings, clientBeforeSendCallBack, clientSideSuccessCallBack, clientSideCancelCallBack, uploadErrorCallBack)
    {
        // what rendering the lists needs, before the parent renders them
        this.texts = settings.texts || {};
        this.uploads = uploadsOf[settings.inputName] = uploadsOf[settings.inputName] || [];
        Base.call(this, settings, clientBeforeSendCallBack, clientSideSuccessCallBack, clientSideCancelCallBack, uploadErrorCallBack);
        const query = this.resourceUrl.indexOf('?');
        this.endpoint = this.resourceUrl.substring(0, query);
        this.query = this.resourceUrl.substring(query + 1);
        this.chunkSize = settings.chunkSize;
        this.parallelUploads = settings.parallelUploads || 1;
        this.remembering = settings.remembering !== false;
        const self = this;
        this.uploads.forEach(function (upload) {
            upload.field = self;
        });
    };

    Field.prototype = Object.create(Base.prototype);
    Field.prototype.constructor = Field;

    /**
     * @param url the URL of the endpoint or of an upload
     * @param query the query string of the field
     * @returns {string} the URL with the query
     */
    function withQuery(url, query)
    {
        return url + (url.indexOf('?') < 0 ? '?' : '&') + query;
    }

    /**
     * @param text a text
     * @returns {string} the text, encoded in UTF-8 and then in base64
     */
    function base64(text)
    {
        const bytes = new window.TextEncoder().encode(text);
        let binary = '';
        for (let index = 0; index < bytes.length; index++) {
            binary += String.fromCharCode(bytes[index]);
        }
        return window.btoa(binary);
    }

    /**
     * @param upload an upload
     * @returns {string} the key the URL of the upload is remembered under in the local storage
     */
    function storageKey(upload)
    {
        const file = upload.file;
        const endpoint = new window.URL(upload.field.endpoint, document.baseURI).href;
        return STORAGE_PREFIX + endpoint + '::' + [file.name, file.size, file.lastModified, file.type].join('::');
    }

    function remembered(upload)
    {
        if (!upload.field.remembering) {
            return null;
        }
        try {
            return window.localStorage.getItem(storageKey(upload));
        } catch (e) {
            return null;
        }
    }

    function remember(upload)
    {
        if (upload.field.remembering) {
            try {
                window.localStorage.setItem(storageKey(upload), upload.url);
            } catch (e) {
                // a browser without storage, or with a full one, cannot resume after a reload
            }
        }
    }

    function forget(upload)
    {
        try {
            window.localStorage.removeItem(storageKey(upload));
        } catch (e) {
            // nothing remembered
        }
    }

    /**
     * @param status the status of an answer of the server
     * @returns {boolean} whether the request is worth sending again
     */
    function isTransient(status)
    {
        return status === 0 || status === 409 || status === 423 || status === 429 || status >= 500;
    }

    /**
     * Sends a request of tus for an upload.
     *
     * @param upload the upload
     * @param method the method
     * @param url the URL, without the query of the field
     * @param headers the headers
     * @param body the body, a Blob, or null
     * @returns {Promise<XMLHttpRequest>} the request once answered; rejected with the request
     *          when it got no answer, which is aborted when it stalled
     */
    function send(upload, method, url, headers, body)
    {
        return new Promise(function (resolve, reject) {
            const xhr = new XMLHttpRequest();
            let stall = null;
            const unstall = function () {
                window.clearTimeout(stall);
            };
            const restall = function () {
                unstall();
                stall = window.setTimeout(function () {
                    xhr.abort();
                }, STALL_MILLIS);
            };
            xhr.open(method, withQuery(url, upload.field.query));
            xhr.setRequestHeader('Tus-Resumable', TUS_RESUMABLE);
            Object.keys(headers).forEach(function (name) {
                xhr.setRequestHeader(name, headers[name]);
            });
            if (body) {
                xhr.upload.onprogress = function (event) {
                    upload.sent = event.loaded;
                    upload.field.progress(upload);
                    // all of a chunk can be in the buffers of the network long before the answer
                    if (event.loaded < body.size) {
                        restall();
                    } else {
                        unstall();
                    }
                };
                restall();
            }
            xhr.onload = function () {
                unstall();
                resolve(xhr);
            };
            xhr.onerror = xhr.ontimeout = xhr.onabort = function () {
                unstall();
                reject(xhr);
            };
            upload.xhr = xhr;
            xhr.send(body || null);
        });
    }

    /**
     * Ends an upload whose file the server stored, and tells the server of it.
     *
     * @param upload the upload
     * @param fileName the name the file was stored under
     */
    function completed(upload, fileName)
    {
        const field = upload.field;
        upload.state = 'done';
        forget(upload);
        field.discard(upload);
        field.clientSideSuccessCallBack();
        field.report({'error': false, 'filesInfo': JSON.stringify([{
            'fileName': fileName,
            'clientFileName': upload.file.name,
            'contentType': upload.file.type || 'application/octet-stream'
        }])});
        field.pump();
    }

    /**
     * Ends an upload that failed, keeping it in the lists to be resumed or removed, and tells the
     * page and the server why.
     *
     * @param upload the upload
     * @param errorMessage the key of the error
     */
    function failed(upload, errorMessage)
    {
        const field = upload.field;
        upload.state = 'failed';
        upload.error = errorMessage;
        upload.xhr = null;
        field.renderLists();
        const ep = {'error': true, 'errorMessage': errorMessage};
        field.uploadErrorCallBack(ep);
        field.report(ep);
        field.pump();
    }

    /**
     * Sends the chunks of an upload from the offset the server holds, until the file is whole.
     *
     * @returns {Promise} done when the server stored the file
     */
    function sendChunks(upload, run)
    {
        if (upload.run !== run) {
            return Promise.resolve();
        }
        const end = Math.min(upload.file.size, upload.offset + upload.field.chunkSize);
        const headers = {'Upload-Offset': String(upload.offset), 'Content-Type': CHUNK_TYPE};
        upload.sent = 0;
        return send(upload, 'PATCH', upload.url, headers, upload.file.slice(upload.offset, end)).then(function (xhr) {
            if (upload.run !== run) {
                return;
            }
            const offset = xhr.getResponseHeader('Upload-Offset');
            if (offset !== null) {
                upload.offset = Number(offset);
            }
            upload.sent = 0;
            if (xhr.status === 204) {
                upload.attempt = 0;
                const fileName = xhr.getResponseHeader(FILE_NAME_HEADER);
                if (fileName !== null) {
                    completed(upload, fileName);
                    return;
                }
                upload.field.progress(upload);
                return sendChunks(upload, run);
            }
            throw xhr;
        });
    }

    /**
     * Asks the server how many bytes of an upload it holds.
     *
     * @returns {Promise<boolean>} whether the server still has the upload
     */
    function ask(upload, run)
    {
        return send(upload, 'HEAD', upload.url, {}, null).then(function (xhr) {
            if (upload.run !== run || xhr.status === 404 || xhr.status === 410 || xhr.status === 403) {
                return false;
            }
            if (xhr.status !== 200) {
                throw xhr;
            }
            upload.offset = Number(xhr.getResponseHeader('Upload-Offset')) || 0;
            const fileName = xhr.getResponseHeader(FILE_NAME_HEADER);
            if (fileName !== null) {
                completed(upload, fileName);
                upload.run++;
            } else if (upload.offset >= upload.file.size) {
                // stored for another field, a rendering before a reload of the page
                throw UPLOAD_LOST;
            }
            return true;
        });
    }

    /**
     * Creates an upload on the server.
     *
     * @returns {Promise} done when the server created it, or stored an empty file
     */
    function create(upload, run)
    {
        const file = upload.file;
        const headers = {
            'Upload-Length': String(file.size),
            'Upload-Metadata': 'filename ' + base64(file.name) + ',filetype ' + base64(file.type || 'application/octet-stream')
        };
        return send(upload, 'POST', upload.field.endpoint, headers, null).then(function (xhr) {
            if (upload.run !== run) {
                return;
            }
            if (xhr.status !== 201) {
                throw xhr;
            }
            upload.url = xhr.getResponseHeader('Location');
            upload.offset = 0;
            const fileName = xhr.getResponseHeader(FILE_NAME_HEADER);
            if (fileName !== null) {
                completed(upload, fileName);
                upload.run++;
                return;
            }
            remember(upload);
        });
    }

    /**
     * Goes on with an upload after a request failed: once more after a while, or once the browser
     * is online again, unless the failure is final.
     */
    function retry(upload, run, problem)
    {
        if (upload.run !== run) {
            return;
        }
        upload.xhr = null;
        if (typeof problem === 'string') {
            failed(upload, problem);
            return;
        }
        if (!(problem instanceof XMLHttpRequest)) {
            Wicket.Log.error('The upload of ' + upload.file.name + ' failed', problem);
            failed(upload, UPLOAD_FAILED);
            return;
        }
        const status = problem.status;
        if (!isTransient(status)) {
            if (status === 404 || status === 410) {
                forget(upload);
                failed(upload, UPLOAD_LOST);
            } else {
                failed(upload, problem.getResponseHeader(ERROR_HEADER) || UPLOAD_FAILED);
            }
            return;
        }
        if (navigator.onLine === false) {
            upload.state = 'offline';
            upload.field.renderLists();
            const online = function () {
                window.removeEventListener('online', online);
                if (upload.run === run) {
                    upload.field.begin(upload);
                }
            };
            window.addEventListener('online', online);
            return;
        }
        if (upload.attempt >= RETRY_DELAYS.length) {
            failed(upload, status === 0 ? CONNECTION_LOST : (problem.getResponseHeader(ERROR_HEADER) || UPLOAD_FAILED));
            return;
        }
        upload.state = 'retrying';
        upload.field.renderLists();
        upload.timer = window.setTimeout(function () {
            if (upload.run === run) {
                upload.field.begin(upload);
            }
        }, RETRY_DELAYS[upload.attempt++]);
    }

    /**
     * Starts an upload, or goes on with it: from where the server got, if it has the upload,
     * whose URL may be remembered from an earlier page; else from the start.
     *
     * @param upload the upload
     */
    Field.prototype.begin = function (upload)
    {
        const run = ++upload.run;
        upload.state = 'uploading';
        upload.error = null;
        upload.field.renderLists();
        const url = upload.url || remembered(upload);
        let begun;
        if (url) {
            upload.url = url;
            begun = ask(upload, run).then(function (known) {
                if (!known && upload.run === run) {
                    forget(upload);
                    upload.url = null;
                    return create(upload, run);
                }
            });
        } else {
            begun = create(upload, run);
        }
        begun.then(function () {
            return sendChunks(upload, run);
        }).catch(function (problem) {
            retry(upload, run, problem);
        });
    };

    /**
     * @returns {boolean} whether the upload is sending, or about to
     */
    function isActive(upload)
    {
        return upload.state === 'uploading' || upload.state === 'retrying' || upload.state === 'offline';
    }

    /**
     * Stops the requests of an upload, if any.
     */
    function halt(upload)
    {
        upload.run++;
        window.clearTimeout(upload.timer);
        if (upload.xhr) {
            upload.xhr.abort();
            upload.xhr = null;
        }
    }

    /**
     * Sends each file chosen in the input as an upload of its own, unless they break a limit of
     * the field: the server is told of that as of an upload it refused, without the files being
     * sent. The uploads wait until fewer than allowed are sending.
     *
     * @returns {boolean} whether the files are sent
     */
    Field.prototype.upload = function ()
    {
        const files = Array.from(this.input.files);
        if (files.length === 0) {
            this.failed(NO_FILE_SELECTED);
            return false;
        }
        const exceededLimit = this.exceededLimit(files);
        if (exceededLimit) {
            this.failed(exceededLimit);
            return false;
        }
        if (this.clientBeforeSendCallBack(null) === false) {
            Wicket.Log.log("The upload of field '" + this.inputName + "' was not sent: the before-send callback returned false.");
            this.report({'error': true, 'errorMessage': UPLOAD_CANCELED});
            return false;
        }
        const self = this;
        files.forEach(function (file) {
            self.uploads.push({
                'key': ++lastKey, 'file': file, 'field': self, 'state': 'waiting', 'url': null,
                'offset': 0, 'sent': 0, 'attempt': 0, 'run': 0, 'xhr': null, 'timer': null, 'error': null
            });
        });
        this.files = [];
        this.updateInput();
        this.pump();
        this.renderLists();
        return true;
    };

    /**
     * Starts as many waiting uploads as may run at the same time.
     */
    Field.prototype.pump = function ()
    {
        let running = this.uploads.filter(isActive).length;
        this.uploads.forEach(function (upload) {
            if (upload.state === 'waiting' && running < this.parallelUploads) {
                running++;
                this.begin(upload);
            }
        }, this);
    };

    /**
     * @returns {boolean} whether an upload of the field is sending, or about to
     */
    Field.prototype.isUploading = function ()
    {
        return this.uploads.some(isActive);
    };

    /**
     * Renders the lists once files the field did not send failed.
     */
    Field.prototype.ended = function ()
    {
        this.renderLists();
    };

    /**
     * Takes an upload that ended out of the lists.
     */
    Field.prototype.discard = function (upload)
    {
        const index = this.uploads.indexOf(upload);
        if (index >= 0) {
            this.uploads.splice(index, 1);
        }
        this.renderLists();
    };

    /**
     * Pauses an upload, or all the uploads of the field that send or wait.
     *
     * @param upload the upload, or undefined for all
     */
    Field.prototype.pause = function (upload)
    {
        const paused = upload ? [upload] : this.uploads.filter(function (each) {
            return isActive(each) || each.state === 'waiting';
        });
        paused.forEach(function (each) {
            halt(each);
            each.state = 'paused';
        });
        this.renderLists();
        this.pump();
    };

    /**
     * Resumes an upload, or all the paused and failed uploads of the field: they wait until
     * fewer uploads than allowed are sending.
     *
     * @param upload the upload, or undefined for all
     */
    Field.prototype.resume = function (upload)
    {
        const resumed = upload ? [upload] : this.uploads.filter(function (each) {
            return each.state === 'paused' || each.state === 'failed';
        });
        resumed.forEach(function (each) {
            each.state = 'waiting';
            each.attempt = 0;
        });
        this.pump();
        this.renderLists();
    };

    /**
     * Cancels an upload, or all the uploads of the field, deleting them on the server, and tells
     * the server, once.
     *
     * @param upload the upload, or undefined for all
     */
    Field.prototype.cancel = function (upload)
    {
        const canceled = upload ? [upload] : this.uploads.slice();
        if (canceled.length === 0) {
            Wicket.Log.log("No upload of field '" + this.inputName + "' to cancel: it has already ended, or never started.");
            return;
        }
        canceled.forEach(function (each) {
            halt(each);
            each.state = 'canceled';
            forget(each);
            if (each.url) {
                send(each, 'DELETE', each.url, {}, null).catch(function () {
                    // the server deletes it once it expires
                });
            }
            this.discard(each);
        }, this);
        this.clientSideCancelCallBack();
        this.report({'error': true, 'errorMessage': UPLOAD_CANCELED});
        this.pump();
    };

    /**
     * Shows how far an upload got, without rendering the lists again.
     */
    Field.prototype.progress = function (upload)
    {
        const sent = Math.min(upload.file.size, upload.offset + upload.sent);
        (upload.views || []).forEach(function (view) {
            view.progress.value = sent;
            view.status.textContent = this.statusOf(upload, sent);
        }, this);
    };

    /**
     * @returns {string} the state of an upload in words
     */
    Field.prototype.statusOf = function (upload, sent)
    {
        const percent = upload.file.size > 0 ? Math.floor(100 * sent / upload.file.size) + '%' : '';
        const texts = this.texts;
        switch (upload.state) {
            case 'uploading':
                return percent;
            case 'failed':
                return texts.failed || '';
            case 'paused':
                return (texts.paused || '') + ' ' + percent;
            default:
                return texts[upload.state] || '';
        }
    };

    /**
     * @returns {HTMLButtonElement} a button labelled by its text and the name of a file
     */
    function button(id, className, text, name, onClick)
    {
        const result = document.createElement('button');
        result.type = 'button';
        result.id = id;
        result.className = className;
        result.textContent = text;
        result.setAttribute('aria-labelledby', id + ' ' + name.id);
        result.addEventListener('click', onClick);
        return result;
    }

    /**
     * Renders the uploads of the field into a list, each with its progress and buttons to pause
     * or resume it and to cancel it, followed by the files chosen for the next upload.
     *
     * @param list the ul or ol
     * @param removeText the text of the buttons removing a file
     */
    Field.prototype.renderList = function (list, removeText)
    {
        const self = this;
        const focused = document.activeElement && list.contains(document.activeElement) ? document.activeElement.id : null;
        list.replaceChildren();
        this.uploads.forEach(function (upload) {
            list.appendChild(self.renderUpload(list, upload));
        });
        this.files.forEach(function (file, index) {
            const name = document.createElement('span');
            name.className = 'wicket-upload-file-name';
            name.id = list.id + '-' + index + '-name';
            name.textContent = file.name;
            const remove = button(list.id + '-' + index + '-remove', 'wicket-upload-file-remove', removeText, name, function () {
                self.remove(file);
            });
            const item = document.createElement('li');
            item.className = 'wicket-upload-file';
            item.append(name, ' ', remove);
            list.appendChild(item);
        });
        const again = focused ? document.getElementById(focused) : null;
        if (again) {
            again.focus();
        }
    };

    /**
     * @returns {HTMLLIElement} the item of an upload in a list
     */
    Field.prototype.renderUpload = function (list, upload)
    {
        const self = this;
        const texts = this.texts;
        const id = list.id + '-upload-' + upload.key;
        const name = document.createElement('span');
        name.className = 'wicket-upload-file-name';
        name.id = id + '-name';
        name.textContent = upload.file.name;
        const progress = document.createElement('progress');
        progress.className = 'wicket-resumable-upload-progress';
        progress.max = upload.file.size || 1;
        progress.setAttribute('aria-labelledby', name.id);
        const status = document.createElement('span');
        status.className = 'wicket-resumable-upload-status';
        const pausing = isActive(upload) || upload.state === 'waiting';
        const toggle = button(id + '-toggle', 'wicket-resumable-upload-' + (pausing ? 'pause' : 'resume'),
            pausing ? texts.pause : texts.resume, name, function () {
                if (pausing) {
                    self.pause(upload);
                } else {
                    self.resume(upload);
                }
            });
        const cancel = button(id + '-cancel', 'wicket-resumable-upload-cancel', texts.cancel, name, function () {
            self.cancel(upload);
        });
        const item = document.createElement('li');
        item.className = 'wicket-upload-file wicket-resumable-upload';
        item.setAttribute('data-state', upload.state);
        item.append(name, ' ', progress, ' ', status, ' ', toggle, ' ', cancel);
        upload.views = (upload.views || []).filter(function (view) {
            return view.list !== list && document.body.contains(view.progress);
        });
        upload.views.push({'list': list, 'progress': progress, 'status': status});
        this.progress(upload);
        return item;
    };
})();
