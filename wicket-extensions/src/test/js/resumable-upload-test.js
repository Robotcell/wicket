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

/*global QUnit: true, DataTransfer: true */

;(function (undefined) {
	"use strict";

	Wicket.Event.add(window, 'domready', function() {
		const { module, test } = QUnit;

		const TEXTS = {waiting: 'Waiting', paused: 'Paused', retrying: 'Retrying', offline: 'Offline',
			failed: 'Failed', pause: 'Pause', resume: 'Resume', cancel: 'Cancel'};

		// stands in for the XMLHttpRequest the field sends its requests with
		function FakeXhr() {
			FakeXhr.instances.push(this);
			this.status = 0;
			this.headers = {};
			this.responseHeaders = {};
			this.upload = {};
		}
		FakeXhr.prototype.open = function (method, url) {
			this.method = method;
			this.url = url;
		};
		FakeXhr.prototype.setRequestHeader = function (name, value) {
			this.headers[name] = value;
		};
		FakeXhr.prototype.getResponseHeader = function (name) {
			return name in this.responseHeaders ? this.responseHeaders[name] : null;
		};
		FakeXhr.prototype.send = function (body) {
			this.body = body;
			this.running = true;
		};
		FakeXhr.prototype.respond = function (status, headers) {
			this.status = status;
			this.responseHeaders = headers || {};
			this.running = false;
			this.onload();
		};
		FakeXhr.prototype.fail = function () {
			this.running = false;
			this.onerror();
		};
		FakeXhr.prototype.abort = function () {
			if (this.running) {
				this.running = false;
				this.aborted = true;
				this.onabort();
			}
		};

		let originalXhr, originalPost, reports, calls, assert_, fields, inputs = 0;

		// lets the promises of the field run, and timers of no delay
		function settle() {
			return new Promise(resolve => window.setTimeout(resolve, 0));
		}

		function last() {
			return FakeXhr.instances[FakeXhr.instances.length - 1];
		}

		function running() {
			return FakeXhr.instances.filter(xhr => xhr.running);
		}

		function newFile(name, size) {
			return new File([new Uint8Array(size)], name, {type: 'text/plain', lastModified: 1000});
		}

		function choose(field, files) {
			const dataTransfer = new DataTransfer();
			files.forEach(file => dataTransfer.items.add(file));
			field.input.files = dataTransfer.files;
			field.files = files;
		}

		// a field of an input of its own, with a list
		function newField(settings, inputId) {
			const id = inputId || 'resumable' + (++inputs);
			if (!document.getElementById(id)) {
				const input = document.createElement('input');
				input.type = 'file';
				input.multiple = true;
				input.id = id;
				const list = document.createElement('ul');
				list.id = id + '-list';
				document.getElementById('qunit-fixture').append(input, list);
			}
			const field = new Wicket.ResumableUploadToResourceField(Object.assign({
					inputName: id,
					resourceUrl: '/uploads',
					ajaxCallBackUrl: 'callback',
					maxSize: 100,
					fileMaxSize: 50,
					fileCountMax: -1,
					uploadToken: 'token',
					chunkSize: 4,
					parallelUploads: 1,
					remembering: false,
					texts: TEXTS
				}, settings),
				function () { return true; },
				function () { calls.push('success'); },
				function () { calls.push('cancel'); },
				function (res) { calls.push('error:' + res.errorMessage); });
			Wicket.Timer[id] = field;
			fields.push(field);
			Wicket.FileUploadToResourceField.addList(id, id + '-list', 'Remove');
			return field;
		}

		function items(field) {
			return Array.from(document.getElementById(field.inputName + '-list').children);
		}

		// creates the upload of the next file, answering its POST
		function created(location) {
			assert_.equal(last().method, 'POST');
			last().respond(201, {'Location': location, 'Upload-Offset': '0'});
			return settle();
		}

		module('Wicket.ResumableUploadToResourceField', {
			beforeEach: function (assert) {
				assert_ = assert;
				originalXhr = window.XMLHttpRequest;
				originalPost = Wicket.Ajax.post;
				FakeXhr.instances = [];
				window.XMLHttpRequest = FakeXhr;
				reports = [];
				calls = [];
				fields = [];
				Wicket.Ajax.post = function (attrs) {
					reports.push(attrs);
				};
				Object.keys(window.localStorage).filter(key => key.indexOf('wicket-resumable-upload::') === 0)
					.forEach(key => window.localStorage.removeItem(key));
			},
			afterEach: function () {
				// the uploads would go on beyond the test that started them
				fields.forEach(field => field.pause());
				FakeXhr.instances.forEach(xhr => xhr.abort());
				window.XMLHttpRequest = originalXhr;
				Wicket.Ajax.post = originalPost;
			}
		});

		test('sends a file in chunks and reports it once the server stored it', assert => {
			const field = newField();
			choose(field, [newFile('a ü.txt', 10)]);

			assert.true(field.upload());

			const create = last();
			assert.equal(create.method, 'POST');
			assert.equal(create.url, '/uploads?uploadId=' + field.inputName + '&maxSize=100&fileMaxSize=50&fileCountMax=-1&uploadToken=token');
			assert.equal(create.headers['Tus-Resumable'], '1.0.0');
			assert.equal(create.headers['Upload-Length'], '10');
			assert.equal(create.headers['Upload-Metadata'], 'filename YSDDvC50eHQ=,filetype dGV4dC9wbGFpbg==');
			assert.equal(field.input.files.length, 0, 'the files left the input');
			assert.equal(items(field)[0].getAttribute('data-state'), 'uploading');
			return created('/uploads/u1').then(function () {
				const first = last();
				assert.equal(first.method, 'PATCH');
				assert.equal(first.url, '/uploads/u1?uploadId=' + field.inputName + '&maxSize=100&fileMaxSize=50&fileCountMax=-1&uploadToken=token');
				assert.equal(first.headers['Upload-Offset'], '0');
				assert.equal(first.headers['Content-Type'], 'application/offset+octet-stream');
				assert.equal(first.body.size, 4);
				first.upload.onprogress({loaded: 2});
				assert.equal(items(field)[0].querySelector('progress').value, 2);
				assert.equal(items(field)[0].querySelector('.wicket-resumable-upload-status').textContent, '20%');
				first.respond(204, {'Upload-Offset': '4'});
				return settle();
			}).then(function () {
				assert.equal(last().headers['Upload-Offset'], '4');
				last().respond(204, {'Upload-Offset': '8'});
				return settle();
			}).then(function () {
				assert.equal(last().body.size, 2);
				last().respond(204, {'Upload-Offset': '10', 'Wicket-Upload-File-Name': 'stored'});
				return settle();
			}).then(function () {
				assert.deepEqual(calls, ['success']);
				assert.equal(reports.length, 1);
				assert.equal(reports[0].u, 'callback');
				assert.deepEqual(reports[0].ep, {'error': false, 'filesInfo': JSON.stringify([
					{'fileName': 'stored', 'clientFileName': 'a ü.txt', 'contentType': 'text/plain'}])});
				assert.equal(items(field).length, 0, 'the upload left the list');
				assert.false(field.isUploading());
			});
		});

		test('pauses an upload and resumes it where the server got', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 10)]);
			field.upload();
			return created('/uploads/u1').then(function () {
				const chunk = last();
				items(field)[0].querySelector('.wicket-resumable-upload-pause').click();
				assert.true(chunk.aborted);
				const item = items(field)[0];
				assert.equal(item.getAttribute('data-state'), 'paused');
				assert.equal(item.querySelector('.wicket-resumable-upload-resume').textContent, 'Resume');
				assert.false(field.isUploading());
				assert.equal(reports.length, 0, 'a pause is no end');

				item.querySelector('.wicket-resumable-upload-resume').click();
				assert.equal(last().method, 'HEAD');
				assert.equal(last().url.split('?')[0], '/uploads/u1');
				last().respond(200, {'Upload-Offset': '3', 'Upload-Length': '10'});
				return settle();
			}).then(function () {
				assert.equal(last().method, 'PATCH');
				assert.equal(last().headers['Upload-Offset'], '3');
			});
		});

		test('goes on after a broken connection, from where the server got', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 10)]);
			field.upload();
			return created('/uploads/u1').then(function () {
				last().fail();
				return settle();
			}).then(function () {
				return settle();
			}).then(function () {
				assert.equal(last().method, 'HEAD', 'asks after the first, immediate retry');
				last().respond(200, {'Upload-Offset': '2'});
				return settle();
			}).then(function () {
				assert.equal(last().headers['Upload-Offset'], '2');
				assert.equal(reports.length, 0);
			});
		});

		test('waits for the browser to be online again', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 10)]);
			field.upload();
			Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => false});
			return created('/uploads/u1').then(function () {
				last().fail();
				return settle();
			}).then(function () {
				assert.equal(items(field)[0].getAttribute('data-state'), 'offline');
				assert.equal(items(field)[0].querySelector('.wicket-resumable-upload-status').textContent, 'Offline');
				const requests = FakeXhr.instances.length;
				delete navigator.onLine;
				window.dispatchEvent(new Event('online'));
				assert.equal(FakeXhr.instances.length, requests + 1);
				assert.equal(last().method, 'HEAD');
			}).finally(function () {
				delete navigator.onLine;
			});
		});

		test('resumes an upload remembered from an earlier page', assert => {
			const field = newField({remembering: true});
			const file = newFile('a.txt', 10);
			choose(field, [file]);
			field.upload();
			return created('/uploads/u1').then(function () {
				field.pause();

				const again = newField({remembering: true});
				choose(again, [newFile('a.txt', 10)]);
				again.upload();
				assert.equal(last().method, 'HEAD');
				assert.equal(last().url.split('?')[0], '/uploads/u1');
				last().respond(200, {'Upload-Offset': '8'});
				return settle();
			}).then(function () {
				assert.equal(last().method, 'PATCH');
				assert.equal(last().headers['Upload-Offset'], '8');
				last().respond(204, {'Upload-Offset': '10', 'Wicket-Upload-File-Name': 'stored'});
				return settle();
			}).then(function () {
				assert.equal(Object.keys(window.localStorage).filter(key => key.indexOf('wicket-resumable-upload::') === 0).length, 0,
					'forgotten once stored');
			});
		});

		test('starts anew when the server lost a remembered upload', assert => {
			const field = newField({remembering: true});
			choose(field, [newFile('a.txt', 10)]);
			field.upload();
			return created('/uploads/u1').then(function () {
				field.pause();
				const again = newField({remembering: true});
				choose(again, [newFile('a.txt', 10)]);
				again.upload();
				last().respond(404);
				return settle();
			}).then(function () {
				assert.equal(last().method, 'POST');
			});
		});

		test('reports the refusal of the server with its key, and keeps the upload to resume it', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 10)]);
			field.upload();
			last().respond(403, {'Wicket-Upload-Error': 'resumableUploadTooMany'});
			return settle().then(function () {
				assert.deepEqual(calls, ['error:resumableUploadTooMany']);
				assert.deepEqual(reports[0].ep, {'error': true, 'errorMessage': 'resumableUploadTooMany'});
				const item = items(field)[0];
				assert.equal(item.getAttribute('data-state'), 'failed');
				assert.equal(item.querySelector('.wicket-resumable-upload-status').textContent, 'Failed');

				item.querySelector('.wicket-resumable-upload-resume').click();
				assert.equal(last().method, 'POST', 'tried again');
			});
		});

		test('reports an upload the server no longer has as lost', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 10)]);
			field.upload();
			return created('/uploads/u1').then(function () {
				last().respond(404);
				return settle();
			}).then(function () {
				assert.deepEqual(reports[0].ep, {'error': true, 'errorMessage': 'resumableUploadLost'});
			});
		});

		test('cancels an upload, deleting it on the server', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 10)]);
			field.upload();
			return created('/uploads/u1').then(function () {
				const chunk = last();
				items(field)[0].querySelector('.wicket-resumable-upload-cancel').click();
				assert.true(chunk.aborted);
				assert.equal(last().method, 'DELETE');
				assert.equal(last().url.split('?')[0], '/uploads/u1');
				assert.deepEqual(calls, ['cancel']);
				assert.deepEqual(reports.map(report => report.ep), [{'error': true, 'errorMessage': 'upload.canceled'}]);
				assert.equal(items(field).length, 0);
			});
		});

		test('refuses files beyond the limits of the field without sending them', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 51)]);

			assert.false(field.upload());

			assert.equal(FakeXhr.instances.length, 0);
			assert.deepEqual(reports[0].ep, {'error': true, 'errorMessage': 'uploadSingleFileTooLarge'});
		});

		test('sends as many files at once as allowed, the others waiting', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 2), newFile('b.txt', 2)]);
			field.upload();

			assert.equal(running().length, 1);
			assert.deepEqual(items(field).map(item => item.getAttribute('data-state')), ['uploading', 'waiting']);
			assert.equal(items(field)[1].querySelector('.wicket-resumable-upload-status').textContent, 'Waiting');
			return created('/uploads/u1').then(function () {
				last().respond(204, {'Upload-Offset': '2', 'Wicket-Upload-File-Name': 'a'});
				return settle();
			}).then(function () {
				assert.equal(last().method, 'POST');
				assert.equal(last().headers['Upload-Metadata'].split(',')[0], 'filename Yi50eHQ=');
			});
		});

		test('stores an empty file as the server creates its upload', assert => {
			const field = newField();
			choose(field, [newFile('empty.txt', 0)]);
			field.upload();
			last().respond(201, {'Location': '/uploads/u1', 'Upload-Offset': '0', 'Wicket-Upload-File-Name': 'stored'});
			return settle().then(function () {
				assert.deepEqual(calls, ['success']);
				assert.equal(FakeXhr.instances.length, 1, 'no chunk to send');
			});
		});

		test('a new rendering of the field takes over its uploads', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 2)]);
			field.upload();
			return created('/uploads/u1').then(function () {
				const input = field.input;
				const copy = input.cloneNode(false);
				input.replaceWith(copy);
				const again = newField({}, field.inputName);
				assert.equal(items(again).length, 1, 'listed by the new rendering');
				assert.true(again.isUploading());
				last().respond(204, {'Upload-Offset': '2', 'Wicket-Upload-File-Name': 'a'});
				return settle();
			}).then(function () {
				assert.deepEqual(calls, ['success']);
			});
		});

		test('pauses and resumes all its uploads', assert => {
			const field = newField();
			choose(field, [newFile('a.txt', 2), newFile('b.txt', 2)]);
			field.upload();
			field.pause();
			assert.deepEqual(items(field).map(item => item.getAttribute('data-state')), ['paused', 'paused']);
			assert.equal(running().length, 0);
			field.resume();
			assert.deepEqual(items(field).map(item => item.getAttribute('data-state')), ['uploading', 'waiting']);
		});
	});
})();
