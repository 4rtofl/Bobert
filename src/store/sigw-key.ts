import { decryptSecret, encryptSecret } from "../crypto";

/**
 * Bobertが使うsigwのキー(D1のsigw_key。仕様: docs/spec/llm-cost.md「AIの呼び出しと費用の負担」)。
 * サーバー管理者が /sigw で登録する。Bobert全体で1つ。CREDENTIAL_ENCRYPTION_KEYS で暗号化して保存する
 */

/** 暗号文に結び付ける持ち主(ほかの行の暗号文を移しても、復号できないように) */
const OWNER = "sigw_key";

/** 保存したsigwのキー */
export interface StoredSigwKey {
	key: string;
	/** キーの末尾4文字 */
	last4: string;
	/** 登録したときに、sigwが返した呼べるプロバイダ */
	providers: string[];
	registeredBy: string;
	registeredAt: number;
}

interface SigwKeyRow {
	key_version: number;
	iv: string;
	ciphertext: string;
	last4: string;
	providers: string;
	registered_by: string;
	registered_at: number;
}

/** 保存したキーを読む。登録していなければnull */
export async function loadSigwKey(env: Env): Promise<StoredSigwKey | null> {
	const row = await env.DB.prepare(
		"SELECT key_version, iv, ciphertext, last4, providers, registered_by, registered_at FROM sigw_key WHERE id = 1",
	).first<SigwKeyRow>();
	if (row === null) {
		return null;
	}
	const key = await decryptSecret(
		{ keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext },
		OWNER,
		env.CREDENTIAL_ENCRYPTION_KEYS,
	);
	return {
		key,
		last4: row.last4,
		providers: parseProviders(row.providers),
		registeredBy: row.registered_by,
		registeredAt: row.registered_at,
	};
}

/** キーを保存する(登録し直したときは置き換える) */
export async function saveSigwKey(
	env: Env,
	stored: StoredSigwKey,
): Promise<void> {
	const secret = await encryptSecret(
		stored.key,
		OWNER,
		env.CREDENTIAL_ENCRYPTION_KEYS,
	);
	await env.DB.prepare(
		`INSERT INTO sigw_key (id, key_version, iv, ciphertext, last4, providers, registered_by, registered_at)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			key_version = excluded.key_version,
			iv = excluded.iv,
			ciphertext = excluded.ciphertext,
			last4 = excluded.last4,
			providers = excluded.providers,
			registered_by = excluded.registered_by,
			registered_at = excluded.registered_at`,
	)
		.bind(
			secret.keyVersion,
			secret.iv,
			secret.ciphertext,
			stored.last4,
			JSON.stringify(stored.providers),
			stored.registeredBy,
			stored.registeredAt,
		)
		.run();
}

function parseProviders(text: string): string[] {
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}
