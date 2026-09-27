package com.mirattic.sync.presence;

/** Lower-case constants so the wire format matches the TS `MediaProvider` union. */
public enum MediaProvider {
	youtube, netflix, laftel,
	/** Fake player from @mirattic/sync-core for development and tests. */
	mock
}
