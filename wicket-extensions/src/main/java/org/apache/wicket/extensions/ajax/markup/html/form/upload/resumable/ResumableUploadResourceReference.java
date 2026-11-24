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

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.apache.wicket.Application;
import org.apache.wicket.IApplicationListener;
import org.apache.wicket.Session;
import org.apache.wicket.markup.html.form.upload.FileUpload;
import org.apache.wicket.markup.html.form.upload.resource.FolderUploadsFileManager;
import org.apache.wicket.markup.html.form.upload.resource.IUploadsFileManager;
import org.apache.wicket.request.cycle.RequestCycle;
import org.apache.wicket.request.resource.IResource;
import org.apache.wicket.request.resource.ResourceReference;
import org.apache.wicket.util.lang.Args;
import org.apache.wicket.util.lang.Bytes;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The resource {@link ResumableUploadToResourceField} sends its files to, in chunks, over the
 * open <a href="https://tus.io/protocols/resumable-upload">tus protocol 1.0</a>: the browser
 * creates an upload ({@code POST}), appends chunks to it ({@code PATCH}), asks how many bytes the
 * server holds after a pause, a broken connection or a reload of the page ({@code HEAD}) and may
 * delete it ({@code DELETE}). Once the server holds the whole file, it goes to the
 * {@link IUploadsFileManager}, as the files sent to a
 * {@link org.apache.wicket.markup.html.form.upload.resource.FileUploadResourceReference} do, and
 * the field hears of it as of those.
 * <p>
 * The application mounts it once, in {@code init()}:
 *
 * <pre>
 * mountResource("/resumable-uploads",
 * 	new ResumableUploadResourceReference(new FolderUploadsFileManager(folder)));
 * </pre>
 *
 * Each upload gets a random name below that path. The bytes received go into files of their own in
 * a folder, {@link #getFolder()}, until the file is whole. What the server knows of the uploads is
 * kept in memory.
 * <p>
 * Every request carries the id of the upload field and the limits of its uploads, signed by the
 * field with the {@link org.apache.wicket.settings.SecuritySettings#getCryptFactory() crypt} of
 * the application, so the browser cannot raise them. An upload belongs to the HTTP session that
 * created it: the requests of another session are told there is no such upload, and a request
 * without a session creates none. A request without the header {@code Tus-Resumable} is refused,
 * which a form of another site cannot send without asking the browser first.
 * <p>
 * The server keeps no more than it is allowed to:
 * <ul>
 * <li>a file larger than the field allows, or larger than {@link #setMaxFileSize(Bytes)}, is
 * refused as the browser creates its upload, before a byte is sent;</li>
 * <li>a session has at most {@link #setMaxUploadsPerSession(int)} uploads running at once, at most
 * {@link #setMaxBytesPerSession(Bytes)} together, all sessions together at most
 * {@link #setMaxTotalBytes(Bytes)}, while at least {@link #setMinFreeSpace(Bytes)} stays free on
 * the disk;</li>
 * <li>a request carries at most {@link #setMaxChunkSize(Bytes)}, which has to be less than a proxy
 * in front of the server lets through;</li>
 * <li>an upload the browser sent nothing to for {@link #setExpiry(Duration)} is deleted, and so
 * are the uploads of a session that ends, and all of them when the application stops.</li>
 * </ul>
 * <p>
 * Wicket's filter answers {@code OPTIONS} itself, so the server does not announce its version and
 * extensions that way; tus clients do not need to ask. A proxy refusing {@code PATCH} is passed by
 * a {@code POST} with {@code X-HTTP-Method-Override: PATCH}.
 *
 * @see ResumableUploadToResourceField
 * @since 12.0.0
 */
public class ResumableUploadResourceReference extends ResourceReference
{
	private static final long serialVersionUID = 1L;

	private static final Logger LOG = LoggerFactory.getLogger(
		ResumableUploadResourceReference.class);

	/** The name the reference is registered under. */
	public static final String NAME = "resumable-uploads";

	/**
	 * The header of the answer that completes an upload, and of a {@code HEAD} after it: the name
	 * the file manager stored the file under.
	 */
	public static final String FILE_NAME_HEADER = "Wicket-Upload-File-Name";

	/** The header of a refusal: the resource key of its error. */
	public static final String ERROR_HEADER = "Wicket-Upload-Error";

	/** The size of a file at most, by default. */
	public static final Bytes DEFAULT_MAX_FILE_SIZE = Bytes.gigabytes(1);

	/** The size of a request at most, by default. */
	public static final Bytes DEFAULT_MAX_CHUNK_SIZE = Bytes.megabytes(16);

	/** How long an upload is kept without news of the browser, by default. */
	public static final Duration DEFAULT_EXPIRY = Duration.ofMinutes(30);

	/** The number of uploads a session has running at once at most, by default. */
	public static final int DEFAULT_MAX_UPLOADS_PER_SESSION = 10;

	/** The space left free on the disk, by default. */
	public static final Bytes DEFAULT_MIN_FREE_SPACE = Bytes.megabytes(512);

	/** How often, at most, the requests look for uploads that expired. */
	private static final Duration SWEEP = Duration.ofMinutes(1);

	/** The names of the uploads, and of their files: 32 hexadecimal digits. */
	private static final Pattern NAME_PATTERN = Pattern.compile("[0-9a-f]{32}");

	private static final SecureRandom RANDOM = new SecureRandom();

	private final IUploadsFileManager fileManager;

	private final File folder;

	private final boolean ownFolder;

	private final transient Map<String, ResumableUpload> uploads = new ConcurrentHashMap<>();

	private final AtomicBoolean listening = new AtomicBoolean();

	private Bytes maxFileSize = DEFAULT_MAX_FILE_SIZE;

	private Bytes maxChunkSize = DEFAULT_MAX_CHUNK_SIZE;

	private int maxUploadsPerSession = DEFAULT_MAX_UPLOADS_PER_SESSION;

	private Bytes maxBytesPerSession;

	private Bytes maxTotalBytes = Bytes.MAX;

	private Bytes minFreeSpace = DEFAULT_MIN_FREE_SPACE;

	private Duration expiry = DEFAULT_EXPIRY;

	private Clock clock = Clock.systemUTC();

	private volatile Instant swept = Instant.EPOCH;

	/**
	 * Creates the reference, keeping the bytes of unfinished uploads in a new folder in the
	 * temporary folder of the JVM, which is deleted when the application stops.
	 *
	 * @param fileManager
	 *            where the files go once they are whole, a {@link FolderUploadsFileManager} for
	 *            example
	 */
	public ResumableUploadResourceReference(IUploadsFileManager fileManager)
	{
		this(fileManager, newTemporaryFolder(), true);
	}

	/**
	 * Creates the reference.
	 *
	 * @param fileManager
	 *            where the files go once they are whole, a {@link FolderUploadsFileManager} for
	 *            example
	 * @param folder
	 *            the folder of the bytes of unfinished uploads, which holds nothing else: the
	 *            files the uploads of an earlier run left there are deleted
	 */
	public ResumableUploadResourceReference(IUploadsFileManager fileManager, File folder)
	{
		this(fileManager, folder, false);
	}

	private ResumableUploadResourceReference(IUploadsFileManager fileManager, File folder,
		boolean ownFolder)
	{
		super(ResumableUploadResourceReference.class, NAME);
		this.fileManager = Args.notNull(fileManager, "fileManager");
		this.folder = Args.notNull(folder, "folder");
		this.ownFolder = ownFolder;
		deleteFiles();
	}

	private static File newTemporaryFolder()
	{
		try
		{
			return Files.createTempDirectory("wicket-resumable-uploads").toFile();
		}
		catch (IOException e)
		{
			throw new IllegalStateException("Could not create a folder for resumable uploads", e);
		}
	}

	/**
	 * @return the reference mounted in the application of the current thread
	 * @throws IllegalStateException
	 *             when the application mounted none
	 */
	public static ResumableUploadResourceReference getInstance()
	{
		ResourceReference reference = Application.get()
			.getResourceReferenceRegistry()
			.getResourceReference(ResumableUploadResourceReference.class, NAME, null, null, null,
				false, false);
		if (reference instanceof ResumableUploadResourceReference resumable)
		{
			return resumable;
		}
		throw new IllegalStateException("No " + ResumableUploadResourceReference.class.getName() +
			" is mounted: mount one in the init() of the application");
	}

	@Override
	public IResource getResource()
	{
		return new ResumableUploadResource(this);
	}

	/**
	 * Creates the query that a client other than {@link ResumableUploadToResourceField}, a React
	 * application or a mobile app for example, adds to the URL of each of its requests: the id its
	 * files are stored under and their limits, signed with the
	 * {@link org.apache.wicket.settings.SecuritySettings#getCryptFactory() crypt} of the
	 * application, so the client cannot change them. Once a file is whole, the answer tells the
	 * name it was stored under in the header {@value #FILE_NAME_HEADER}, which the client hands
	 * back to the application, for it to find the file with
	 * {@code getFileManager().getFile(uploadFieldId, name)}.
	 * <p>
	 * The id has to be unique in the application and must not come from the browser. The name the
	 * client hands back does: the application has to check that the id is one it gave the
	 * client's session.
	 *
	 * @param uploadFieldId
	 *            the id the files are stored under
	 * @param maxSize
	 *            the size of the files sent at once, and of each file, at most
	 * @param fileMaxSize
	 *            the size of each file at most, {@code null} for {@code maxSize}
	 * @param fileCountMax
	 *            the number of files sent at once at most, -1 for any
	 * @return the query, without its {@code ?}
	 */
	public String newQuery(String uploadFieldId, Bytes maxSize, Bytes fileMaxSize,
		long fileCountMax)
	{
		Args.notEmpty(uploadFieldId, "uploadFieldId");
		Args.notNull(maxSize, "maxSize");
		return UploadGrant.of(uploadFieldId, maxSize, fileMaxSize, fileCountMax).query();
	}

	/**
	 * @return where the files go once they are whole
	 */
	public IUploadsFileManager getFileManager()
	{
		return fileManager;
	}

	/**
	 * @return the folder of the bytes of unfinished uploads
	 */
	public File getFolder()
	{
		return folder;
	}

	/**
	 * @return the size of a file at most
	 */
	public Bytes getMaxFileSize()
	{
		return maxFileSize;
	}

	/**
	 * Sets the size of a file at most, for all fields: the limits of a field can only be lower.
	 *
	 * @param maxFileSize
	 *            the size, {@link #DEFAULT_MAX_FILE_SIZE} by default
	 * @return {@code this}
	 */
	public ResumableUploadResourceReference setMaxFileSize(Bytes maxFileSize)
	{
		this.maxFileSize = Args.notNull(maxFileSize, "maxFileSize");
		return this;
	}

	/**
	 * @return the number of bytes a request carries at most
	 */
	public Bytes getMaxChunkSize()
	{
		return maxChunkSize;
	}

	/**
	 * @param maxChunkSize
	 *            the number of bytes a request carries at most, {@link #DEFAULT_MAX_CHUNK_SIZE} by
	 *            default
	 * @return {@code this}
	 */
	public ResumableUploadResourceReference setMaxChunkSize(Bytes maxChunkSize)
	{
		Args.notNull(maxChunkSize, "maxChunkSize");
		Args.isTrue(maxChunkSize.bytes() > 0, "maxChunkSize must be positive");
		this.maxChunkSize = maxChunkSize;
		return this;
	}

	/**
	 * @return the number of uploads a session has running at once at most
	 */
	public int getMaxUploadsPerSession()
	{
		return maxUploadsPerSession;
	}

	/**
	 * @param maxUploadsPerSession
	 *            the number of unfinished uploads a session has at once at most,
	 *            {@link #DEFAULT_MAX_UPLOADS_PER_SESSION} by default
	 * @return {@code this}
	 */
	public ResumableUploadResourceReference setMaxUploadsPerSession(int maxUploadsPerSession)
	{
		Args.isTrue(maxUploadsPerSession > 0, "maxUploadsPerSession must be positive");
		this.maxUploadsPerSession = maxUploadsPerSession;
		return this;
	}

	/**
	 * @return the size of the unfinished uploads of a session together at most
	 */
	public Bytes getMaxBytesPerSession()
	{
		return maxBytesPerSession != null ? maxBytesPerSession
			: Bytes.bytes(Math.min(Long.MAX_VALUE / 4, maxFileSize.bytes()) * 4);
	}

	/**
	 * @param maxBytesPerSession
	 *            the size of the unfinished uploads of a session together at most; four times
	 *            {@link #getMaxFileSize()} by default, which {@code null} restores
	 * @return {@code this}
	 */
	public ResumableUploadResourceReference setMaxBytesPerSession(Bytes maxBytesPerSession)
	{
		this.maxBytesPerSession = maxBytesPerSession;
		return this;
	}

	/**
	 * @return the size of the unfinished uploads of all sessions together at most
	 */
	public Bytes getMaxTotalBytes()
	{
		return maxTotalBytes;
	}

	/**
	 * @param maxTotalBytes
	 *            the size of the unfinished uploads of all sessions together at most, no limit by
	 *            default
	 * @return {@code this}
	 */
	public ResumableUploadResourceReference setMaxTotalBytes(Bytes maxTotalBytes)
	{
		this.maxTotalBytes = Args.notNull(maxTotalBytes, "maxTotalBytes");
		return this;
	}

	/**
	 * @return the space the uploads leave free on the disk of the folder
	 */
	public Bytes getMinFreeSpace()
	{
		return minFreeSpace;
	}

	/**
	 * @param minFreeSpace
	 *            the space the uploads leave free on the disk of the folder,
	 *            {@link #DEFAULT_MIN_FREE_SPACE} by default
	 * @return {@code this}
	 */
	public ResumableUploadResourceReference setMinFreeSpace(Bytes minFreeSpace)
	{
		this.minFreeSpace = Args.notNull(minFreeSpace, "minFreeSpace");
		return this;
	}

	/**
	 * @return how long an upload is kept without news of the browser
	 */
	public Duration getExpiry()
	{
		return expiry;
	}

	/**
	 * @param expiry
	 *            how long an upload is kept without news of the browser, {@link #DEFAULT_EXPIRY} by
	 *            default; the browser is told when its upload expires
	 * @return {@code this}
	 */
	public ResumableUploadResourceReference setExpiry(Duration expiry)
	{
		Args.notNull(expiry, "expiry");
		Args.isTrue(!expiry.isNegative() && !expiry.isZero(), "expiry must be positive");
		this.expiry = expiry;
		return this;
	}

	/**
	 * Lets the bytes of a chunk be read through another stream, one counting or scanning them for
	 * example. Returns the body itself by default.
	 *
	 * @param body
	 *            the body of the request
	 * @param upload
	 *            the upload the chunk belongs to
	 * @return the stream to read
	 */
	protected InputStream wrapBody(InputStream body, ResumableUpload upload)
	{
		return body;
	}

	ResumableUploadResourceReference setClock(Clock clock)
	{
		this.clock = Args.notNull(clock, "clock");
		return this;
	}

	Instant now()
	{
		return clock.instant();
	}

	/**
	 * @return the id of the HTTP session of the current request, {@code null} without one
	 */
	static String currentOwner()
	{
		if (!Application.exists() || RequestCycle.get() == null)
		{
			return null;
		}
		Session session = Session.get();
		return session.isTemporary() ? null : session.getId();
	}

	/**
	 * @return the upload of a name if it belongs to the session, {@code null} otherwise
	 */
	ResumableUpload find(String id, String owner)
	{
		if (id == null || owner == null || !NAME_PATTERN.matcher(id).matches())
		{
			return null;
		}
		ResumableUpload upload = uploads.get(id);
		return upload != null && upload.getOwner().equals(owner) ? upload : null;
	}

	/**
	 * @return the unfinished uploads of a session
	 */
	private List<ResumableUpload> unfinishedUploadsOf(String owner)
	{
		return uploads.values()
			.stream()
			.filter(upload -> upload.getOwner().equals(owner) && !upload.isStored())
			.toList();
	}

	/**
	 * Creates an upload, unless it breaks a limit.
	 *
	 * @return the upload
	 * @throws Refusal
	 *             when it breaks a limit
	 */
	synchronized ResumableUpload create(String owner, UploadGrant grant, long length,
		Map<String, String> metadata) throws Refusal
	{
		listen();
		if (length > Math.min(maxFileSize.bytes(), grant.maxFileSize()))
		{
			throw new Refusal(413, ResumableUploadToResourceField.UPLOAD_TOO_LARGE_RESOURCE_KEY);
		}
		List<ResumableUpload> own = unfinishedUploadsOf(owner);
		if (own.size() >= maxUploadsPerSession)
		{
			throw new Refusal(403, ResumableUploadToResourceField.TOO_MANY_UPLOADS_RESOURCE_KEY);
		}
		long ownBytes = own.stream().mapToLong(ResumableUpload::getLength).sum();
		if (ownBytes + length > getMaxBytesPerSession().bytes())
		{
			throw new Refusal(413, ResumableUploadToResourceField.TOO_MUCH_RESOURCE_KEY);
		}
		long allBytes = uploads.values()
			.stream()
			.filter(upload -> !upload.isStored())
			.mapToLong(ResumableUpload::getLength)
			.sum();
		if (allBytes + length > maxTotalBytes.bytes() || !hasRoom(length))
		{
			throw new Refusal(507, ResumableUploadToResourceField.NO_ROOM_RESOURCE_KEY);
		}
		byte[] random = new byte[16];
		RANDOM.nextBytes(random);
		String id = HexFormat.of().formatHex(random);
		try
		{
			Path file = Files.createFile(folder.toPath().resolve(id));
			ResumableUpload upload = new ResumableUpload(id, owner, grant.uploadFieldId(), length,
				metadata, file, now());
			uploads.put(id, upload);
			return upload;
		}
		catch (IOException e)
		{
			LOG.warn("Could not create the file of an upload in {}", folder, e);
			throw new Refusal(507, ResumableUploadToResourceField.NO_ROOM_RESOURCE_KEY);
		}
	}

	/**
	 * @return whether the disk of the folder has room for more bytes, leaving free the space it
	 *         has to
	 */
	private boolean hasRoom(long length)
	{
		try
		{
			Files.createDirectories(folder.toPath());
			long usable = Files.getFileStore(folder.toPath()).getUsableSpace();
			long pending = uploads.values()
				.stream()
				.filter(upload -> !upload.isStored())
				.mapToLong(upload -> upload.getLength() - upload.getOffset())
				.sum();
			return usable - pending - length >= minFreeSpace.bytes();
		}
		catch (IOException e)
		{
			return false;
		}
	}

	/**
	 * Hands the whole file of an upload to the file manager, for an upload field.
	 *
	 * @param upload
	 *            the upload, whose lock the current thread holds
	 * @param uploadFieldId
	 *            the id of the field
	 */
	void store(ResumableUpload upload, String uploadFieldId)
	{
		FileUpload file = new FileUpload(new ReceivedFileItem(upload));
		String name = fileManager.store(file, uploadFieldId);
		upload.deleteFile();
		upload.stored(uploadFieldId, name, now());
	}

	/**
	 * Deletes an upload and its bytes, waiting a moment for a request writing them.
	 *
	 * @return whether it was deleted: not while a request keeps writing it
	 */
	boolean delete(ResumableUpload upload)
	{
		try
		{
			if (!upload.lock.tryLock(ResumableUploadResource.LOCK_WAIT.toMillis(),
				TimeUnit.MILLISECONDS))
			{
				return false;
			}
		}
		catch (InterruptedException e)
		{
			Thread.currentThread().interrupt();
			return false;
		}
		try
		{
			forget(upload);
			return true;
		}
		finally
		{
			upload.lock.unlock();
		}
	}

	private void forget(ResumableUpload upload)
	{
		uploads.remove(upload.getId(), upload);
		upload.deleteFile();
	}

	/**
	 * Deletes the uploads the browser sent nothing to for longer than the expiry, at most once a
	 * minute unless forced, but not those a request is writing.
	 *
	 * @param force
	 *            whether to look now, however recently it looked
	 */
	void deleteExpired(boolean force)
	{
		Instant now = now();
		if (!force && swept.plus(SWEEP).isAfter(now))
		{
			return;
		}
		swept = now;
		for (ResumableUpload upload : new ArrayList<>(uploads.values()))
		{
			if (!expiresAt(upload).isAfter(now) && upload.lock.tryLock())
			{
				try
				{
					forget(upload);
				}
				finally
				{
					upload.lock.unlock();
				}
			}
		}
	}

	/**
	 * @return when an upload expires, unless the browser sends something
	 */
	Instant expiresAt(ResumableUpload upload)
	{
		return upload.getTouched().plus(expiry);
	}

	/**
	 * @return the number of uploads known, finished or not, of all sessions
	 */
	int size()
	{
		return uploads.size();
	}

	/**
	 * Deletes the uploads of the sessions that end, and all of them when the application stops.
	 */
	private void listen()
	{
		if (!listening.compareAndSet(false, true))
		{
			return;
		}
		Application application = Application.get();
		application.getSessionStore().registerUnboundListener(sessionId -> {
			for (ResumableUpload upload : new ArrayList<>(uploads.values()))
			{
				if (upload.getOwner().equals(sessionId))
				{
					forget(upload);
				}
			}
		});
		application.getApplicationListeners().add(new IApplicationListener()
		{
			@Override
			public void onBeforeDestroyed(Application destroyed)
			{
				uploads.clear();
				deleteFiles();
				if (ownFolder && !folder.delete())
				{
					LOG.debug("Could not delete the folder of resumable uploads {}", folder);
				}
			}
		});
	}

	/**
	 * Deletes the files of uploads in the folder.
	 */
	private void deleteFiles()
	{
		if (!folder.isDirectory())
		{
			return;
		}
		try (Stream<Path> files = Files.list(folder.toPath()))
		{
			for (Path file : files.filter(
				path -> NAME_PATTERN.matcher(path.getFileName().toString()).matches()).toList())
			{
				Files.deleteIfExists(file);
			}
		}
		catch (IOException e)
		{
			LOG.warn("Could not delete the files of resumable uploads in {}", folder, e);
		}
	}

	/**
	 * A limit an upload breaks: the status the browser is told, and the resource key of the
	 * error its field reports.
	 */
	static final class Refusal extends Exception
	{
		private static final long serialVersionUID = 1L;

		final int status;

		final String key;

		Refusal(int status, String key)
		{
			super(key, null, false, false);
			this.status = status;
			this.key = key;
		}
	}
}
