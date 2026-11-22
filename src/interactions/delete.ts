import type { APIInteractionResponse } from "discord-api-types/v10";
import {
	agentClient,
	agentsAvailable,
	retireAgentResources,
} from "../agent/managed";
import { deleteAgentVault } from "../agent/secrets";
import {
	type AgentChannel,
	type AgentResources,
	agentChannelsOf,
	deleteAgentRecordsOf,
	getAgentResources,
	getAgentVault,
} from "../agent/store";
import { agentSessionStub, gatewayStub } from "../agent/stubs";
import { DELETE_AGENTS_NOTE, DELETE_GITHUB_NOTE } from "../agent/texts";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import { revokeGitHubAuthorization } from "../github/account";
import { logEvent } from "../log";
import { DELETE_MEMORY_NOTE } from "../memory/texts";
import { isDonating } from "../store/donations";
import { hasGitHubLink, loadGitHubLink } from "../store/github";
import { deleteUserMemory, hasAnyMemory } from "../store/memory";
import { deleteUserData } from "../store/users";
import {
	deleteVideoRecordsOf,
	getVideoJob,
	getVideoResources,
	videoJobStub,
} from "../video/store";
import { DELETE_VIDEO_NOTE } from "../video/texts";

/** /delete の確認のボタンのID */
export const DELETE_CONFIRM_ID = "delete:confirm";

/**
 * /delete: 消してよいか、本人にだけ確かめる。寄付している人には、寄付も使われなくなることを書く。
 * 記憶を使ったことがある人には、記憶も消すことを、
 * エージェントのチャンネルがある人には、チャンネルとセッションも消すことを、
 * GitHubと連携している人には、連携も外すことを書く
 */
export async function deleteCommand(
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	const donation = (await isDonating(env.DB, userId))
		? "寄付したクレジットも、使われなくなります。"
		: "";
	const memory = (await hasAnyMemory(env.DB, userId)) ? DELETE_MEMORY_NOTE : "";
	const agents =
		(await agentChannelsOf(env.DB, userId)).length > 0
			? DELETE_AGENTS_NOTE
			: "";
	const github = (await hasGitHubLink(env.DB, userId))
		? DELETE_GITHUB_NOTE
		: "";
	const video = (await getVideoJob(env.DB, userId)) ? DELETE_VIDEO_NOTE : "";
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			content: `登録したAPIキー(Anthropic、OpenRouter、TypeSafe)と設定を、すべて削除します。${donation}${memory}${agents}${video}${github}よろしいですか?`,
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							style: ButtonStyle.Danger,
							custom_id: DELETE_CONFIRM_ID,
							label: "削除する",
						},
					],
				},
			],
		},
	};
}

/**
 * 確認のボタン: キーと設定と記憶を消す(仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」)。
 * エージェントと動画のセッションは、記録を消してから、裏でsigw経由で消す(sigwが、消す直前までの費用を本人に付ける)。
 * GitHubとの連携も同じく、トークンを読んでおき、記録を消してから、裏でGitHubの側の承認を取り消す
 */
export async function confirmDelete(
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): Promise<APIInteractionResponse> {
	const channels = await agentChannelsOf(env.DB, userId);
	const resources = await getAgentResources(env.DB, userId);
	const vaultId = await getAgentVault(env.DB, userId);
	const hasAgents =
		channels.length > 0 || resources !== null || vaultId !== null;
	const videoJob = await getVideoJob(env.DB, userId);
	const videoResources = await getVideoResources(env.DB, userId);
	const hasVideo = videoJob !== null || videoResources !== null;
	const github = await loadGitHubLink(env, userId);
	await deleteAgentRecordsOf(env.DB, userId);
	await deleteVideoRecordsOf(env.DB, userId);
	await deleteUserData(env.DB, userId);
	await deleteUserMemory(env.DB, userId);
	logEvent("interactions", "user_data_deleted", { userId });
	if (hasAgents) {
		ctx.waitUntil(removeAgents(env, userId, channels, resources, vaultId));
	}
	if (hasVideo) {
		ctx.waitUntil(removeVideo(env, userId, videoJob !== null, videoResources));
	}
	if (github !== null) {
		ctx.waitUntil(revokeGitHubAuthorization(env, userId, github));
	}
	return {
		type: InteractionResponseType.UpdateMessage,
		data: {
			content:
				"削除しました。OpenRouterで発行されたキーは、OpenRouterのサイトでも削除できます。また使うときは `/setup` から登録してください。",
			components: [],
		},
	};
}

/**
 * 本人のエージェントのセッションとチャンネルを消し、本人のために作った環境と、秘密を預けたvaultを消して、エージェントの設定をアーカイブする。
 * 失敗しても、キーと設定はもう消してあるので、記録を残すだけにする
 */
async function removeAgents(
	env: Env,
	userId: string,
	channels: readonly AgentChannel[],
	resources: AgentResources | null,
	vaultId: string | null,
): Promise<void> {
	// Bobertにsigwのキーがなければ、Bobertのワークスペースのものは消せない
	const client = agentsAvailable(env) ? agentClient(env, userId) : null;
	for (const channel of channels) {
		try {
			await agentSessionStub(env, channel.channelId).purge();
			await gatewayStub(env).removeAgentChannel(channel.channelId);
		} catch (error) {
			logEvent("agent", "delete_cleanup_failed", {
				userId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	// エージェントに渡す秘密は、vaultごと消す
	if (vaultId !== null && client !== null) {
		await deleteAgentVault(client, vaultId).catch((error: unknown) => {
			logEvent("agent", "vault_cleanup_failed", {
				userId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
	if (resources !== null && client !== null) {
		await retireAgentResources(client, resources).catch((error: unknown) => {
			logEvent("agent", "resources_cleanup_failed", {
				userId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}

/**
 * 作っている途中の動画のセッションを消し、本人のために作った動画用の環境を消して、エージェントの設定をアーカイブする。
 * 失敗しても、キーと設定はもう消してあるので、記録を残すだけにする
 */
async function removeVideo(
	env: Env,
	userId: string,
	hasJob: boolean,
	resources: AgentResources | null,
): Promise<void> {
	if (hasJob) {
		await videoJobStub(env, userId)
			.purge()
			.catch((error: unknown) => {
				logEvent("video", "delete_cleanup_failed", {
					userId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}
	if (resources !== null && agentsAvailable(env)) {
		await retireAgentResources(agentClient(env, userId), resources).catch(
			(error: unknown) => {
				logEvent("video", "resources_cleanup_failed", {
					userId,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
	}
}
