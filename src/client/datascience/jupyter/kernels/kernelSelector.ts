// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import '../../../common/extensions';

import type { nbformat } from '@jupyterlab/coreutils';
import type { Kernel } from '@jupyterlab/services';
import { inject, injectable } from 'inversify';
import { CancellationToken } from 'vscode-jsonrpc';

import { IApplicationShell } from '../../../common/application/types';
import { traceError, traceInfo, traceVerbose } from '../../../common/logger';
import { IConfigurationService, IDisposableRegistry, Resource } from '../../../common/types';
import * as localize from '../../../common/utils/localize';
import { noop } from '../../../common/utils/misc';
import { StopWatch } from '../../../common/utils/stopWatch';
import { IInterpreterService } from '../../../interpreter/contracts';
import { PythonInterpreter } from '../../../pythonEnvironments/info';
import { IEventNamePropertyMapping, sendTelemetryEvent } from '../../../telemetry';
import { Commands, KnownNotebookLanguages, Settings, Telemetry } from '../../constants';
import { IKernelFinder } from '../../kernel-launcher/types';
import { reportAction } from '../../progress/decorator';
import { ReportableAction } from '../../progress/types';
import {
    IJupyterConnection,
    IJupyterKernelSpec,
    IJupyterSessionManager,
    IJupyterSessionManagerFactory,
    IKernelDependencyService,
    INotebookMetadataLive,
    INotebookProviderConnection
} from '../../types';
import { createDefaultKernelSpec } from './helpers';
import { KernelSelectionProvider } from './kernelSelections';
import { KernelService } from './kernelService';
import { IKernelSpecQuickPickItem, LiveKernelModel } from './types';

export type KernelSpecInterpreter = {
    kernelSpec?: IJupyterKernelSpec;
    /**
     * Interpreter that goes with the kernelspec.
     * Sometimes, we're unable to determine the exact interpreter associalted with a kernelspec, in such cases this is a closes match.
     * E.g. when selecting a remote kernel, we do not have the remote interpreter information, we can only try to find a close match.
     *
     * @type {PythonInterpreter}
     */
    interpreter?: PythonInterpreter;
    /**
     * Active kernel from an active session.
     * If this is available, then user needs to connect to an existing kernel (instead of starting a new session).
     *
     * @type {(LiveKernelModel)}
     */
    kernelModel?: LiveKernelModel;
};

@injectable()
export class KernelSelector {
    /**
     * List of ids of kernels that should be hidden from the kernel picker.
     *
     * @private
     * @type {new Set<string>}
     * @memberof KernelSelector
     */
    private readonly kernelIdsToHide = new Set<string>();
    constructor(
        @inject(KernelSelectionProvider) private readonly selectionProvider: KernelSelectionProvider,
        @inject(IApplicationShell) private readonly applicationShell: IApplicationShell,
        @inject(KernelService) private readonly kernelService: KernelService,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IKernelDependencyService) private readonly kernelDepdencyService: IKernelDependencyService,
        @inject(IKernelFinder) private readonly kernelFinder: IKernelFinder,
        @inject(IJupyterSessionManagerFactory) private jupyterSessionManagerFactory: IJupyterSessionManagerFactory,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry
    ) {
        disposableRegistry.push(
            this.jupyterSessionManagerFactory.onRestartSessionCreated(this.addKernelToIgnoreList.bind(this))
        );
        disposableRegistry.push(
            this.jupyterSessionManagerFactory.onRestartSessionUsed(this.removeKernelFromIgnoreList.bind(this))
        );
    }

    /**
     * Ensure kernels such as those associated with the restart session are not displayed in the kernel picker.
     *
     * @param {Kernel.IKernelConnection} kernel
     * @memberof KernelSelector
     */
    public addKernelToIgnoreList(kernel: Kernel.IKernelConnection): void {
        this.kernelIdsToHide.add(kernel.id);
        this.kernelIdsToHide.add(kernel.clientId);
    }
    /**
     * Opposite of the add counterpart.
     *
     * @param {Kernel.IKernelConnection} kernel
     * @memberof KernelSelector
     */
    public removeKernelFromIgnoreList(kernel: Kernel.IKernelConnection): void {
        this.kernelIdsToHide.delete(kernel.id);
        this.kernelIdsToHide.delete(kernel.clientId);
    }

    /**
     * Selects a kernel from a remote session.
     *
     * @param {Resource} resource
     * @param {StopWatch} stopWatch
     * @param {IJupyterSessionManager} session
     * @param {CancellationToken} [cancelToken]
     * @param {IJupyterKernelSpec | LiveKernelModel} [currentKernel]
     * @returns {Promise<KernelSpecInterpreter>}
     * @memberof KernelSelector
     */
    public async selectRemoteKernel(
        resource: Resource,
        stopWatch: StopWatch,
        session: IJupyterSessionManager,
        cancelToken?: CancellationToken,
        currentKernelDisplayName?: string
    ): Promise<KernelSpecInterpreter> {
        let suggestions = await this.selectionProvider.getKernelSelectionsForRemoteSession(
            resource,
            session,
            cancelToken
        );
        suggestions = suggestions.filter((item) => !this.kernelIdsToHide.has(item.selection.kernelModel?.id || ''));
        return this.selectKernel(
            resource,
            'jupyter',
            stopWatch,
            Telemetry.SelectRemoteJupyterKernel,
            suggestions,
            session,
            cancelToken,
            currentKernelDisplayName
        );
    }
    /**
     * Select a kernel from a local session.
     *
     * @param {Resource} resource
     * @param type
     * @param {StopWatch} stopWatch
     * @param {IJupyterSessionManager} [session]
     * @param {CancellationToken} [cancelToken]
     * @param {IJupyterKernelSpec | LiveKernelModel} [currentKernel]
     * @returns {Promise<KernelSpecInterpreter>}
     * @memberof KernelSelector
     */
    public async selectLocalKernel(
        resource: Resource,
        type: 'raw' | 'jupyter' | 'noConnection',
        stopWatch: StopWatch,
        session?: IJupyterSessionManager,
        cancelToken?: CancellationToken,
        currentKernelDisplayName?: string
    ): Promise<KernelSpecInterpreter> {
        let suggestions = await this.selectionProvider.getKernelSelectionsForLocalSession(
            resource,
            type,
            session,
            cancelToken
        );
        suggestions = suggestions.filter((item) => !this.kernelIdsToHide.has(item.selection.kernelModel?.id || ''));
        return this.selectKernel(
            resource,
            type,
            stopWatch,
            Telemetry.SelectLocalJupyterKernel,
            suggestions,
            session,
            cancelToken,
            currentKernelDisplayName
        );
    }
    /**
     * Gets a kernel that needs to be used with a local session.
     * (will attempt to find the best matching kernel, or prompt user to use current interpreter or select one).
     *
     * @param {Resource} resource
     * @param type
     * @param {IJupyterSessionManager} [sessionManager]
     * @param {nbformat.INotebookMetadata} [notebookMetadata]
     * @param {boolean} [disableUI]
     * @param {CancellationToken} [cancelToken]
     * @returns {Promise<KernelSpecInterpreter>}
     * @memberof KernelSelector
     */
    @reportAction(ReportableAction.KernelsGetKernelForLocalConnection)
    public async getKernelForLocalConnection(
        resource: Resource,
        type: 'raw' | 'jupyter' | 'noConnection',
        sessionManager?: IJupyterSessionManager,
        notebookMetadata?: nbformat.INotebookMetadata,
        disableUI?: boolean,
        cancelToken?: CancellationToken
    ): Promise<KernelSpecInterpreter> {
        const stopWatch = new StopWatch();
        const telemetryProps: IEventNamePropertyMapping[Telemetry.FindKernelForLocalConnection] = {
            kernelSpecFound: false,
            interpreterFound: false,
            promptedToSelect: false
        };
        // When this method is called, we know we've started a local jupyter server or are connecting raw
        // Lets pre-warm the list of local kernels.
        this.selectionProvider
            .getKernelSelectionsForLocalSession(resource, type, sessionManager, cancelToken)
            .ignoreErrors();

        let selection: KernelSpecInterpreter = {};

        if (type === 'jupyter') {
            selection = await this.getKernelForLocalJupyterConnection(
                resource,
                stopWatch,
                telemetryProps,
                sessionManager,
                notebookMetadata,
                disableUI,
                cancelToken
            );
        } else if (type === 'raw') {
            selection = await this.getKernelForLocalRawConnection(resource, notebookMetadata, cancelToken);
        }

        // If still not found, log an error (this seems possible for some people, so use the default)
        if (!selection.kernelSpec) {
            traceError('Jupyter Kernel Spec not found for a local connection');
        }

        telemetryProps.kernelSpecFound = !!selection.kernelSpec;
        telemetryProps.interpreterFound = !!selection.interpreter;
        sendTelemetryEvent(Telemetry.FindKernelForLocalConnection, stopWatch.elapsedTime, telemetryProps);
        return selection;
    }

    /**
     * Gets a kernel that needs to be used with a remote session.
     * (will attempt to find the best matching kernel, or prompt user to use current interpreter or select one).
     *
     * @param {Resource} resource
     * @param {IJupyterSessionManager} [sessionManager]
     * @param {nbformat.INotebookMetadata} [notebookMetadata]
     * @param {CancellationToken} [cancelToken]
     * @returns {Promise<KernelSpecInterpreter>}
     * @memberof KernelSelector
     */
    // tslint:disable-next-line: cyclomatic-complexity
    @reportAction(ReportableAction.KernelsGetKernelForRemoteConnection)
    public async getKernelForRemoteConnection(
        resource: Resource,
        sessionManager?: IJupyterSessionManager,
        notebookMetadata?: INotebookMetadataLive,
        cancelToken?: CancellationToken
    ): Promise<KernelSpecInterpreter> {
        const [interpreter, specs, sessions] = await Promise.all([
            this.interpreterService.getActiveInterpreter(resource),
            this.kernelService.getKernelSpecs(sessionManager, cancelToken),
            sessionManager?.getRunningSessions()
        ]);

        // First check for a live active session.
        if (notebookMetadata && notebookMetadata.id) {
            const session = sessions?.find((s) => s.kernel.id === notebookMetadata?.id);
            if (session) {
                // tslint:disable-next-line: no-any
                const liveKernel = session.kernel as any;
                const lastActivityTime = liveKernel.last_activity
                    ? new Date(Date.parse(liveKernel.last_activity.toString()))
                    : new Date();
                const numberOfConnections = liveKernel.connections
                    ? parseInt(liveKernel.connections.toString(), 10)
                    : 0;
                return {
                    kernelModel: { ...session.kernel, lastActivityTime, numberOfConnections, session },
                    interpreter: interpreter
                };
            }
        }

        // No running session, try matching based on interpreter
        let bestMatch: IJupyterKernelSpec | undefined;
        let bestScore = -1;
        for (let i = 0; specs && i < specs?.length; i = i + 1) {
            const spec = specs[i];
            let score = 0;

            if (spec) {
                // See if the path matches.
                if (spec && spec.path && spec.path.length > 0 && interpreter && spec.path === interpreter.path) {
                    // Path match
                    score += 8;
                }

                // See if the version is the same
                if (interpreter && interpreter.version && spec && spec.name) {
                    // Search for a digit on the end of the name. It should match our major version
                    const match = /\D+(\d+)/.exec(spec.name);
                    if (match && match !== null && match.length > 0) {
                        // See if the version number matches
                        const nameVersion = parseInt(match[1][0], 10);
                        if (nameVersion && nameVersion === interpreter.version.major) {
                            score += 4;
                        }
                    }
                }

                // See if the display name already matches.
                if (spec.display_name && spec.display_name === notebookMetadata?.kernelspec?.display_name) {
                    score += 16;
                }
            }

            if (score > bestScore) {
                bestMatch = spec;
                bestScore = score;
            }
        }

        return {
            kernelSpec: bestMatch,
            interpreter: interpreter
        };
    }

    public async askForLocalKernel(
        resource: Resource,
        type: 'raw' | 'jupyter' | 'noConnection',
        kernelSpec: IJupyterKernelSpec | LiveKernelModel | undefined
    ): Promise<KernelSpecInterpreter | undefined> {
        const displayName = kernelSpec?.display_name || kernelSpec?.name || '';
        const message = localize.DataScience.sessionStartFailedWithKernel().format(
            displayName,
            Commands.ViewJupyterOutput
        );
        const selectKernel = localize.DataScience.selectDifferentKernel();
        const cancel = localize.Common.cancel();
        const selection = await this.applicationShell.showErrorMessage(message, selectKernel, cancel);
        if (selection === selectKernel) {
            return this.selectLocalJupyterKernel(resource, type, kernelSpec?.display_name || kernelSpec?.name);
        }
    }

    public async selectJupyterKernel(
        resource: Resource,
        connection: INotebookProviderConnection | undefined,
        type: 'raw' | 'jupyter',
        currentKernelDisplayName: string | undefined
    ): Promise<KernelSpecInterpreter | undefined> {
        let kernel: KernelSpecInterpreter | undefined;
        const settings = this.configService.getSettings(resource);
        const isLocalConnection =
            connection?.localLaunch ??
            settings.datascience.jupyterServerURI.toLowerCase() === Settings.JupyterServerLocalLaunch;

        if (isLocalConnection) {
            kernel = await this.selectLocalJupyterKernel(resource, connection?.type || type, currentKernelDisplayName);
        } else if (connection && connection.type === 'jupyter') {
            kernel = await this.selectRemoteJupyterKernel(resource, connection, currentKernelDisplayName);
        }
        return kernel;
    }

    private async selectLocalJupyterKernel(
        resource: Resource,
        type: 'raw' | 'jupyter' | 'noConnection',
        currentKernelDisplayName: string | undefined
    ): Promise<KernelSpecInterpreter> {
        return this.selectLocalKernel(resource, type, new StopWatch(), undefined, undefined, currentKernelDisplayName);
    }

    private async selectRemoteJupyterKernel(
        resource: Resource,
        connInfo: IJupyterConnection,
        currentKernelDisplayName?: string
    ): Promise<KernelSpecInterpreter> {
        const stopWatch = new StopWatch();
        const session = await this.jupyterSessionManagerFactory.create(connInfo);
        return this.selectRemoteKernel(resource, stopWatch, session, undefined, currentKernelDisplayName);
    }

    // Get our kernelspec and matching interpreter for a connection to a local jupyter server
    private async getKernelForLocalJupyterConnection(
        resource: Resource,
        stopWatch: StopWatch,
        telemetryProps: IEventNamePropertyMapping[Telemetry.FindKernelForLocalConnection],
        sessionManager?: IJupyterSessionManager,
        notebookMetadata?: nbformat.INotebookMetadata,
        disableUI?: boolean,
        cancelToken?: CancellationToken
    ): Promise<KernelSpecInterpreter> {
        let selection: KernelSpecInterpreter = {};
        if (notebookMetadata?.kernelspec) {
            selection.kernelSpec = await this.kernelService.findMatchingKernelSpec(
                notebookMetadata?.kernelspec,
                sessionManager,
                cancelToken
            );
            if (selection.kernelSpec) {
                selection.interpreter = await this.kernelService.findMatchingInterpreter(
                    selection.kernelSpec,
                    cancelToken
                );
                sendTelemetryEvent(Telemetry.UseExistingKernel);

                // Make sure we update the environment in the kernel before using it
                await this.kernelService.updateKernelEnvironment(
                    selection.interpreter,
                    selection.kernelSpec,
                    cancelToken
                );
            } else if (!cancelToken?.isCancellationRequested) {
                // No kernel info, hence prmopt to use current interpreter as a kernel.
                const activeInterpreter = await this.interpreterService.getActiveInterpreter(resource);
                if (activeInterpreter) {
                    selection = await this.useInterpreterAsKernel(
                        resource,
                        activeInterpreter,
                        'jupyter',
                        notebookMetadata.kernelspec.display_name,
                        sessionManager,
                        disableUI,
                        cancelToken
                    );
                } else {
                    telemetryProps.promptedToSelect = true;
                    selection = await this.selectLocalKernel(
                        resource,
                        'jupyter',
                        stopWatch,
                        sessionManager,
                        cancelToken
                    );
                }
            }
        } else if (!cancelToken?.isCancellationRequested) {
            // No kernel info, hence use current interpreter as a kernel.
            const activeInterpreter = await this.interpreterService.getActiveInterpreter(resource);
            if (activeInterpreter) {
                selection.interpreter = activeInterpreter;
                selection.kernelSpec = await this.kernelService.searchAndRegisterKernel(
                    activeInterpreter,
                    disableUI,
                    cancelToken
                );
            }
        }

        return selection;
    }

    // Get our kernelspec and interpreter for a local raw connection
    private async getKernelForLocalRawConnection(
        resource: Resource,
        notebookMetadata?: nbformat.INotebookMetadata,
        cancelToken?: CancellationToken
    ): Promise<KernelSpecInterpreter> {
        const selection: KernelSpecInterpreter = {};

        // First use our kernel finder to locate a kernelspec on disk
        selection.kernelSpec = await this.kernelFinder.findKernelSpec(
            resource,
            notebookMetadata?.kernelspec,
            cancelToken
        );

        if (selection.kernelSpec) {
            // Locate the interpreter that matches our kernelspec
            selection.interpreter = await this.kernelService.findMatchingInterpreter(selection.kernelSpec, cancelToken);
        }
        return selection;
    }

    private async selectKernel(
        resource: Resource,
        type: 'raw' | 'jupyter' | 'noConnection',
        stopWatch: StopWatch,
        telemetryEvent: Telemetry,
        suggestions: IKernelSpecQuickPickItem[],
        session?: IJupyterSessionManager,
        cancelToken?: CancellationToken,
        currentKernelDisplayName?: string
    ) {
        const placeHolder =
            localize.DataScience.selectKernel() +
            (currentKernelDisplayName ? ` (current: ${currentKernelDisplayName})` : '');
        sendTelemetryEvent(telemetryEvent, stopWatch.elapsedTime);
        const selection = await this.applicationShell.showQuickPick(suggestions, { placeHolder }, cancelToken);
        if (!selection?.selection) {
            return {};
        }
        // Check if ipykernel is installed in this kernel.
        if (selection.selection.interpreter && type === 'jupyter') {
            sendTelemetryEvent(Telemetry.SwitchToInterpreterAsKernel);
            return this.useInterpreterAsKernel(
                resource,
                selection.selection.interpreter,
                type,
                undefined,
                session,
                false,
                cancelToken
            );
        } else if (selection.selection.interpreter && type === 'raw') {
            return this.useInterpreterAndDefaultKernel(selection.selection.interpreter);
        } else if (selection.selection.kernelModel) {
            sendTelemetryEvent(Telemetry.SwitchToExistingKernel, undefined, {
                language: this.computeLanguage(selection.selection.kernelModel.language)
            });
            // tslint:disable-next-line: no-any
            const interpreter = selection.selection.kernelModel
                ? await this.kernelService.findMatchingInterpreter(selection.selection.kernelModel, cancelToken)
                : undefined;
            return {
                kernelSpec: selection.selection.kernelSpec,
                interpreter,
                kernelModel: selection.selection.kernelModel
            };
        } else if (selection.selection.kernelSpec) {
            sendTelemetryEvent(Telemetry.SwitchToExistingKernel, undefined, {
                language: this.computeLanguage(selection.selection.kernelSpec.language)
            });
            const interpreter = selection.selection.kernelSpec
                ? await this.kernelService.findMatchingInterpreter(selection.selection.kernelSpec, cancelToken)
                : undefined;
            await this.kernelService.updateKernelEnvironment(interpreter, selection.selection.kernelSpec, cancelToken);
            return { kernelSpec: selection.selection.kernelSpec, interpreter };
        } else {
            return {};
        }
    }

    // When switching to an interpreter in raw kernel mode then just create a default kernelspec for that interpreter to use
    private async useInterpreterAndDefaultKernel(interpreter: PythonInterpreter): Promise<KernelSpecInterpreter> {
        const kernelSpec = createDefaultKernelSpec(interpreter.displayName);
        return { kernelSpec, interpreter };
    }

    /**
     * Use the provided interpreter as a kernel.
     * If `displayNameOfKernelNotFound` is provided, then display a message indicating we're using the `current interpreter`.
     * This would happen when we're starting a notebook.
     * Otherwise, if not provided user is changing the kernel after starting a notebook.
     *
     * @private
     * @param {Resource} resource
     * @param {PythonInterpreter} interpreter
     * @param type
     * @param {string} [displayNameOfKernelNotFound]
     * @param {IJupyterSessionManager} [session]
     * @param {boolean} [disableUI]
     * @param {CancellationToken} [cancelToken]
     * @returns {Promise<KernelSpecInterpreter>}
     * @memberof KernelSelector
     */
    private async useInterpreterAsKernel(
        resource: Resource,
        interpreter: PythonInterpreter,
        type: 'raw' | 'jupyter' | 'noConnection',
        displayNameOfKernelNotFound?: string,
        session?: IJupyterSessionManager,
        disableUI?: boolean,
        cancelToken?: CancellationToken
    ): Promise<KernelSpecInterpreter> {
        let kernelSpec: IJupyterKernelSpec | undefined;

        if (await this.kernelDepdencyService.areDependenciesInstalled(interpreter, cancelToken)) {
            // Find the kernel associated with this interpter.
            kernelSpec = await this.kernelService.findMatchingKernelSpec(interpreter, session, cancelToken);

            if (kernelSpec) {
                traceVerbose(`ipykernel installed in ${interpreter.path}, and matching kernelspec found.`);
                // Make sure the environment matches.
                await this.kernelService.updateKernelEnvironment(interpreter, kernelSpec, cancelToken);

                // Notify the UI that we didn't find the initially requested kernel and are just using the active interpreter
                if (displayNameOfKernelNotFound && !disableUI) {
                    this.applicationShell
                        .showInformationMessage(
                            localize.DataScience.fallbackToUseActiveInterpeterAsKernel().format(
                                displayNameOfKernelNotFound
                            )
                        )
                        .then(noop, noop);
                }

                sendTelemetryEvent(Telemetry.UseInterpreterAsKernel);
                return { kernelSpec, interpreter };
            }
            traceInfo(`ipykernel installed in ${interpreter.path}, no matching kernel found. Will register kernel.`);
        }

        // Try an install this interpreter as a kernel.
        try {
            kernelSpec = await this.kernelService.registerKernel(interpreter, disableUI, cancelToken);
        } catch (e) {
            sendTelemetryEvent(Telemetry.KernelRegisterFailed);
            throw e;
        }

        // If we have a display name of a kernel that could not be found,
        // then notify user that we're using current interpreter instead.
        if (displayNameOfKernelNotFound && !disableUI) {
            this.applicationShell
                .showInformationMessage(
                    localize.DataScience.fallBackToRegisterAndUseActiveInterpeterAsKernel().format(
                        displayNameOfKernelNotFound
                    )
                )
                .then(noop, noop);
        }

        // When this method is called, we know a new kernel may have been registered.
        // Lets pre-warm the list of local kernels (with the new list).
        this.selectionProvider.getKernelSelectionsForLocalSession(resource, type, session, cancelToken).ignoreErrors();

        return { kernelSpec, interpreter };
    }

    private computeLanguage(language: string | undefined): string {
        if (language && KnownNotebookLanguages.includes(language.toLowerCase())) {
            return language;
        }
        return 'unknown';
    }
}
