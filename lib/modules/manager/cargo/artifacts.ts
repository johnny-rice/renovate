import { quote } from 'shlex';
import { TEMPORARY_ERROR } from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { coerceArray } from '../../../util/array';
import { exec } from '../../../util/exec';
import type { ExecOptions } from '../../../util/exec/types';
import {
  findLocalSiblingOrParent,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs';
import { getGitEnvironmentVariables } from '../../../util/git/auth';
import { regEx } from '../../../util/regex';
import { CrateDatasource } from '../../datasource/crate';
import type { UpdateArtifact, UpdateArtifactsResult, Upgrade } from '../types';
import { extractLockFileContentVersions } from './locked-version';

async function cargoUpdate(
  manifestPath: string,
  isLockFileMaintenance: boolean,
  constraint: string | undefined,
): Promise<void> {
  let cmd = `cargo update --config net.git-fetch-with-cli=true --manifest-path ${quote(
    manifestPath,
  )}`;
  // If we're updating a specific crate, `cargo-update` requires `--workspace`
  // for more information, see: https://github.com/renovatebot/renovate/issues/12332
  if (!isLockFileMaintenance) {
    cmd += ` --workspace`;
  }

  const execOptions: ExecOptions = {
    extraEnv: { ...getGitEnvironmentVariables(['cargo']) },
    docker: {},
    toolConstraints: [{ toolName: 'rust', constraint }],
  };
  await exec(cmd, execOptions);
}

async function cargoUpdatePrecise(
  manifestPath: string,
  updatedDeps: Upgrade[],
  constraint: string | undefined,
): Promise<void> {
  // First update all dependencies that have been bumped in `Cargo.toml`.
  const cmds = [
    'cargo update --config net.git-fetch-with-cli=true' +
      ` --manifest-path ${quote(manifestPath)} --workspace`,
  ];

  // Update individual dependencies to their `newVersion`. Necessary when
  // using the `update-lockfile` rangeStrategy which doesn't touch Cargo.toml.
  for (const dep of updatedDeps) {
    cmds.push(
      `cargo update --config net.git-fetch-with-cli=true` +
        ` --manifest-path ${quote(manifestPath)}` +
        ` --package ${quote(`${dep.packageName}@${dep.lockedVersion}`)}` +
        ` --precise ${quote(dep.newVersion!)}`,
    );
  }

  const execOptions: ExecOptions = {
    extraEnv: { ...getGitEnvironmentVariables(['cargo']) },
    docker: {},
    toolConstraints: [{ toolName: 'rust', constraint }],
  };

  await exec(cmds, execOptions);
}

export async function updateArtifacts(
  updateArtifact: UpdateArtifact,
): Promise<UpdateArtifactsResult[] | null> {
  return await updateArtifactsImpl(updateArtifact);
}

async function updateArtifactsImpl(
  {
    packageFileName,
    updatedDeps,
    newPackageFileContent,
    config,
  }: UpdateArtifact,
  recursionLimit = 10,
): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`cargo.updateArtifacts(${packageFileName})`);

  // For standalone package crates, the `Cargo.lock` will be in the same
  // directory as `Cargo.toml` (ie. a sibling). For cargo workspaces, it
  // will be further up.
  const lockFileName = await findLocalSiblingOrParent(
    packageFileName,
    'Cargo.lock',
  );
  const existingLockFileContent = lockFileName
    ? await readLocalFile(lockFileName)
    : null;
  if (!existingLockFileContent || !lockFileName) {
    logger.debug('No Cargo.lock found');
    return null;
  }

  const { isLockFileMaintenance } = config;
  if (!isLockFileMaintenance && !updatedDeps?.length) {
    logger.debug('No more dependencies to update');
    return [
      {
        file: {
          type: 'addition',
          path: lockFileName,
          contents: existingLockFileContent,
        },
      },
    ];
  }

  try {
    await writeLocalFile(packageFileName, newPackageFileContent);
    logger.debug('Updating ' + lockFileName);

    if (isLockFileMaintenance) {
      await cargoUpdate(packageFileName, true, config.constraints?.rust);
    } else {
      const nonCrateDep = updatedDeps.find(
        (dep) => dep.datasource !== CrateDatasource.id,
      );
      const crateDepWithoutLockedVersion = updatedDeps.find(
        (dep) => !dep.lockedVersion && dep.datasource === CrateDatasource.id,
      );
      // Non-crate dependencies (like git ones) do not have locked versions.
      // For crate dependencies, not having a locked version is not expected.
      // In both situations, perform a regular workspace lockfile update.
      if (nonCrateDep || crateDepWithoutLockedVersion) {
        if (crateDepWithoutLockedVersion) {
          // Only warn when a crate dependency has no locked version, as this is
          // not an expected situation.
          logger.warn(
            { dependency: crateDepWithoutLockedVersion.depName },
            'Missing locked version for dependency',
          );
        }
        await cargoUpdate(packageFileName, false, config.constraints?.rust);
      } else {
        // If all dependencies have locked versions then update them precisely.
        await cargoUpdatePrecise(
          packageFileName,
          updatedDeps,
          config.constraints?.rust,
        );
      }
    }

    logger.debug('Returning updated Cargo.lock');
    const newCargoLockContent = await readLocalFile(lockFileName);
    if (existingLockFileContent === newCargoLockContent) {
      logger.debug('Cargo.lock is unchanged');
      return null;
    }
    return [
      {
        file: {
          type: 'addition',
          path: lockFileName,
          contents: newCargoLockContent,
        },
      },
    ];
  } catch (err) {
    // istanbul ignore if
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }

    // Sometimes `cargo update` will fail when a preceding dependency update
    // causes another dependency to update. In this case we can no longer
    // reference the dependency by its old version, so we filter it out
    // and retry recursively.
    const newCargoLockContent = await readLocalFile(lockFileName, 'utf8');
    if (
      recursionLimit > 0 &&
      newCargoLockContent &&
      regEx(/error: package ID specification/).test(err.stderr)
    ) {
      const versions = extractLockFileContentVersions(newCargoLockContent);
      const newUpdatedDeps = updatedDeps.filter(
        (dep) =>
          !coerceArray(versions?.get(dep.packageName!)).includes(
            dep.newVersion!,
          ),
      );

      if (newUpdatedDeps.length < updatedDeps.length) {
        logger.debug(
          'Dependency already up to date - reattempting recursively',
        );
        return updateArtifactsImpl(
          {
            packageFileName,
            updatedDeps: newUpdatedDeps,
            newPackageFileContent,
            config,
          },
          recursionLimit - 1,
        );
      }
    }

    logger.debug({ err }, 'Failed to update Cargo lock file');

    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
