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
package org.apache.wicket.extensions.ajax.markup.html.form.upload.resumable;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.apache.wicket.ajax.AjaxRequestTarget;
import org.apache.wicket.core.request.handler.IPartialPageRequestHandler;
import org.apache.wicket.markup.head.HeaderItem;
import org.apache.wicket.markup.head.IHeaderResponse;
import org.apache.wicket.markup.head.JavaScriptHeaderItem;
import org.apache.wicket.markup.head.OnDomReadyHeaderItem;
import org.apache.wicket.markup.html.form.upload.resource.FileUploadToResourceField;
import org.apache.wicket.markup.html.form.upload.resource.IUploadsFileManager;
import org.apache.wicket.model.Model;
import org.apache.wicket.request.mapper.parameter.PageParameters;
import org.apache.wicket.request.resource.JavaScriptResourceReference;
import org.apache.wicket.resource.CoreLibrariesContributor;
import org.apache.wicket.util.lang.Args;
import org.apache.wicket.util.lang.Bytes;
import org.apache.wicket.util.string.Strings;

import com.github.openjson.JSONArray;
import com.github.openjson.JSONObject;

/**
 * A {@link FileUploadToResourceField} whose files go to a {@link ResumableUploadResourceReference}
 * in chunks, each file an upload of its own that can be paused, resumed and canceled, and that
 * goes on by itself after the connection broke off. When the field is
 * {@link #setRemembering(boolean) remembering}, an upload also goes on after the page was
 * reloaded, or the browser restarted, once the user chooses the same file again.
 * <p>
 * Everything else is as for its parent: {@link #startUpload(IPartialPageRequestHandler)} sends
 * the files chosen, a {@link org.apache.wicket.markup.html.form.upload.resource.FileDropZoneBehavior}
 * lets them be dropped and a {@link org.apache.wicket.markup.html.form.upload.resource.FileListBehavior}
 * lists them, there with their progress and buttons to pause, resume and cancel each upload. As
 * each file arrives whole it goes to the {@link IUploadsFileManager} of the reference, and
 * {@link #onUploadSuccess(AjaxRequestTarget, List)} is called with it. A file refused or lost is
 * reported to {@link #onUploadFailure(AjaxRequestTarget, String)}, and a canceled one to
 * {@link #onUploadCanceled(AjaxRequestTarget)}. The functions of the parent's client side
 * callbacks are called as for the parent, per file, except for
 * {@link #getClientBeforeSendCallBack()}: it is called once as the upload starts, with
 * {@code null} instead of a request, since every file makes several.
 * <p>
 * The limits of the field are those of its parent: {@link #setMaxSize(Bytes)} for the files
 * chosen at once and for each file, {@link #setFileMaxSize(Bytes)} for each file and
 * {@link #setFileCountMax(long)} for the number of files chosen at once. Those of the reference
 * apply too, and the lower one wins.
 *
 * @since 12.0.0
 */
public abstract class ResumableUploadToResourceField extends FileUploadToResourceField
{
	private static final long serialVersionUID = 1L;

	/** The script of the parent, which the script of this field builds on. */
	private static final JavaScriptResourceReference PARENT_JS = new JavaScriptResourceReference(
		FileUploadToResourceField.class, "FileUploadToResourceField.js");

	/** The script of the field. */
	public static final JavaScriptResourceReference JS = new JavaScriptResourceReference(
		ResumableUploadToResourceField.class, "ResumableUploadToResourceField.js")
	{
		private static final long serialVersionUID = 1L;

		@Override
		public List<HeaderItem> getDependencies()
		{
			List<HeaderItem> dependencies = super.getDependencies();
			dependencies.add(JavaScriptHeaderItem.forReference(PARENT_JS));
			return dependencies;
		}
	};

	/** The size of a chunk by default. */
	public static final Bytes DEFAULT_CHUNK_SIZE = Bytes.megabytes(8);

	/** The number of files sent at the same time by default. */
	public static final int DEFAULT_PARALLEL_UPLOADS = 2;

	/** The resource key of the text of a file larger than the limits allow. */
	public static final String UPLOAD_TOO_LARGE_RESOURCE_KEY = "resumableUploadTooLarge";

	/** The resource key of the text of a session that has too many uploads running at once. */
	public static final String TOO_MANY_UPLOADS_RESOURCE_KEY = "resumableUploadTooMany";

	/** The resource key of the text of a session whose uploads together are too large. */
	public static final String TOO_MUCH_RESOURCE_KEY = "resumableUploadTooMuch";

	/** The resource key of the text of a server that has no room for a file now. */
	public static final String NO_ROOM_RESOURCE_KEY = "resumableUploadNoRoom";

	/** The resource key of the text of an upload the server no longer has. */
	public static final String UPLOAD_LOST_RESOURCE_KEY = "resumableUploadLost";

	private static final Set<String> RESUMABLE_ERROR_KEYS = Set.of(UPLOAD_TOO_LARGE_RESOURCE_KEY,
		TOO_MANY_UPLOADS_RESOURCE_KEY, TOO_MUCH_RESOURCE_KEY, NO_ROOM_RESOURCE_KEY,
		UPLOAD_LOST_RESOURCE_KEY);

	/** The keys of the texts of the script, without their prefix {@code resumableUpload.}. */
	private static final List<String> TEXTS = List.of("waiting", "paused", "retrying", "offline",
		"failed", "pause", "resume", "cancel");

	private Bytes chunkSize = DEFAULT_CHUNK_SIZE;

	private int parallelUploads = DEFAULT_PARALLEL_UPLOADS;

	private boolean remembering = true;

	/**
	 * @param id
	 *            the component id
	 */
	public ResumableUploadToResourceField(String id)
	{
		super(id);
	}

	/**
	 * @return the reference the files go to, by default the one mounted in the application, see
	 *         {@link ResumableUploadResourceReference#getInstance()}
	 */
	protected ResumableUploadResourceReference getResumableUploadResourceReference()
	{
		return ResumableUploadResourceReference.getInstance();
	}

	/**
	 * @return the file manager of the reference
	 */
	@Override
	protected IUploadsFileManager fileManager()
	{
		return getResumableUploadResourceReference().getFileManager();
	}

	/**
	 * @return the size of each file at most: the lowest of {@link #setFileMaxSize(Bytes)},
	 *         {@link #setMaxSize(Bytes)} and the {@link ResumableUploadResourceReference#getMaxFileSize()
	 *         limit of the reference}
	 */
	@Override
	public Bytes getFileMaxSize()
	{
		long most = Math.min(getMaxSize().bytes(),
			getResumableUploadResourceReference().getMaxFileSize().bytes());
		Bytes fileMaxSize = super.getFileMaxSize();
		return Bytes.bytes(fileMaxSize != null ? Math.min(most, fileMaxSize.bytes()) : most);
	}

	/**
	 * @return the size of a chunk
	 */
	public Bytes getChunkSize()
	{
		return chunkSize;
	}

	/**
	 * Sets the size of the chunks the files are sent in: the smaller they are, the less is sent
	 * again after the connection broke off, and the more requests are made. The chunks are never
	 * larger than the reference takes, see
	 * {@link ResumableUploadResourceReference#setMaxChunkSize(Bytes)}.
	 *
	 * @param chunkSize
	 *            the size, {@link #DEFAULT_CHUNK_SIZE} by default
	 * @return {@code this}
	 */
	public ResumableUploadToResourceField setChunkSize(Bytes chunkSize)
	{
		Args.notNull(chunkSize, "chunkSize");
		Args.isTrue(chunkSize.bytes() > 0, "chunkSize must be positive");
		this.chunkSize = chunkSize;
		return this;
	}

	/**
	 * @return the number of files sent at the same time
	 */
	public int getParallelUploads()
	{
		return parallelUploads;
	}

	/**
	 * @param parallelUploads
	 *            the number of files sent at the same time, {@link #DEFAULT_PARALLEL_UPLOADS} by
	 *            default
	 * @return {@code this}
	 */
	public ResumableUploadToResourceField setParallelUploads(int parallelUploads)
	{
		Args.isTrue(parallelUploads > 0, "parallelUploads must be positive");
		this.parallelUploads = parallelUploads;
		return this;
	}

	/**
	 * @return whether the browser remembers the uploads that did not end
	 */
	public boolean isRemembering()
	{
		return remembering;
	}

	/**
	 * Sets whether the browser remembers the URLs of the uploads that did not end, in its local
	 * storage, by the name, size and date of their files: an upload then goes on after a reload of
	 * the page, or a restart of the browser, once the user chooses the same file again, as long as
	 * the session and the upload last. It remembers no content of the files.
	 *
	 * @param remembering
	 *            whether to remember, {@code true} by default
	 * @return {@code this}
	 */
	public ResumableUploadToResourceField setRemembering(boolean remembering)
	{
		this.remembering = remembering;
		return this;
	}

	@Override
	public void renderHead(IHeaderResponse response)
	{
		CoreLibrariesContributor.contributeAjax(getApplication(), response);
		response.render(JavaScriptHeaderItem.forReference(JS));
		response.render(OnDomReadyHeaderItem.forScript("Wicket.Timer." + getMarkupId() +
			" = new Wicket.ResumableUploadToResourceField(" + newClientSettings() + "," +
			getClientBeforeSendCallBack() + "," + getClientSideSuccessCallBack() + "," +
			getClientSideCancelCallBack() + "," + getClientSideUploadErrorCallBack() + ");"));
	}

	/**
	 * Creates the settings of the script of the field: those of its parent, with the URL of the
	 * reference as {@code resourceUrl} and a token of its own, and {@code chunkSize},
	 * {@code parallelUploads}, {@code remembering} and {@code texts}.
	 *
	 * @return the settings
	 */
	protected JSONObject newClientSettings()
	{
		ResumableUploadResourceReference reference = getResumableUploadResourceReference();
		UploadGrant grant = UploadGrant.of(getMarkupId(), getMaxSize(), getFileMaxSize(),
			getFileCountMax());
		JSONObject settings = new JSONObject();
		settings.put("inputName", getMarkupId());
		settings.put("resourceUrl", Strings.stripEnding(
			urlFor(reference, new PageParameters()).toString(), "/"));
		settings.put("ajaxCallBackUrl", getUploadCallbackUrl());
		settings.put("maxSize", grant.maxSize());
		settings.put("fileMaxSize", grant.fileMaxSize());
		settings.put("fileCountMax", grant.fileCountMax());
		settings.put("uploadToken", grant.token());
		settings.put("chunkSize",
			Math.min(chunkSize.bytes(), reference.getMaxChunkSize().bytes()));
		settings.put("parallelUploads", parallelUploads);
		settings.put("remembering", remembering);
		JSONObject texts = new JSONObject();
		for (String key : TEXTS)
		{
			texts.put(key, getString("resumableUpload." + key));
		}
		settings.put("texts", texts);
		settings.put("errorKeys", new JSONArray(RESUMABLE_ERROR_KEYS));
		return settings;
	}

	/**
	 * Words the errors of the uploads of this field, and leaves the others to its parent.
	 */
	@Override
	protected String getUploadErrorMessage(String errorKey)
	{
		if (errorKey == null || !RESUMABLE_ERROR_KEYS.contains(errorKey))
		{
			return super.getUploadErrorMessage(errorKey);
		}
		ResumableUploadResourceReference reference = getResumableUploadResourceReference();
		Map<String, Object> model = new HashMap<>();
		model.put("fileMaxSize", getFileMaxSize());
		model.put("maxUploadsPerSession", reference.getMaxUploadsPerSession());
		model.put("maxBytesPerSession", reference.getMaxBytesPerSession());
		return getString(errorKey, Model.ofMap(model));
	}

	/**
	 * @return the JavaScript expression pausing the uploads of the field
	 */
	public String getTriggerPauseUploadScript()
	{
		return "Wicket.Timer." + getMarkupId() + ".pause();";
	}

	/**
	 * Pauses the uploads of the field via an Ajax request.
	 *
	 * @param target
	 *            the {@link AjaxRequestTarget}
	 */
	public void pauseUpload(IPartialPageRequestHandler target)
	{
		target.appendJavaScript(getTriggerPauseUploadScript());
	}

	/**
	 * @return the JavaScript expression resuming the paused uploads of the field
	 */
	public String getTriggerResumeUploadScript()
	{
		return "Wicket.Timer." + getMarkupId() + ".resume();";
	}

	/**
	 * Resumes the paused uploads of the field via an Ajax request.
	 *
	 * @param target
	 *            the {@link AjaxRequestTarget}
	 */
	public void resumeUpload(IPartialPageRequestHandler target)
	{
		target.appendJavaScript(getTriggerResumeUploadScript());
	}
}
