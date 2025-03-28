import Foundation
import GraphQLCompiler

// MARK: FileGenerator (protocol and extension)

/// The methods to conform to when building a code generation Swift file generator.
protocol FileGenerator {
  var fileName: String { get }
  var fileExtension: String { get }
  var fileSuffix: String? { get }
  var overwrite: Bool { get }
  var template: any TemplateRenderer { get }
  var target: FileTarget { get }
}

extension FileGenerator {
  var overwrite: Bool { true }
  var fileExtension: String { overwrite ? "graphql.swift" : "swift" }
  var fileSuffix: String? { nil }

  /// Generates the file writing the template content to the specified config output paths.
  ///
  /// - Parameters:
  ///   - config: Shared codegen configuration.
  ///   - fileManager: The `ApolloFileManager` object used to create the file. Defaults to `ApolloFileManager.default`.
  func generate(
    forConfig config: ApolloCodegen.ConfigurationContext,
    fileManager: ApolloFileManager = .default
  ) async throws -> [ApolloCodegen.NonFatalError] {
    let filename = resolveFilename(forConfig: config)
    let directoryPath = target.resolvePath(forConfig: config)
    let filePath = URL(fileURLWithPath: directoryPath)
      .resolvingSymlinksInPath()
      .appendingPathComponent(filename)
      .appendingPathExtension(fileExtension)
      .path

    let (rendered, errors) = template.render()

    if !self.overwrite, let _ = fileSuffix {
      let preSuffixFilename = fileName.firstUppercased
      let preSuffixFilePath = URL(fileURLWithPath: directoryPath)
        .resolvingSymlinksInPath()
        .appendingPathComponent(preSuffixFilename)
        .appendingPathExtension(fileExtension)
        .path

      try await fileManager.renameFile(atPath: preSuffixFilePath, toPath: filePath)
    }

    try await fileManager.createFile(
      atPath: filePath,
      data: rendered.data(using: .utf8),
      overwrite: self.overwrite
    )

    return errors
  }

  /// Filename to be used taking into account any generated filename options.
  private func resolveFilename(forConfig config: ApolloCodegen.ConfigurationContext) -> String {
    let prefix = fileName.firstUppercased
    guard config.options.appendSchemaTypeFilenameSuffix, let suffix = self.fileSuffix else {
      return prefix
    }

    return prefix + suffix
  }
}

// MARK: - FileTarget (path resolver)

enum FileTarget: Equatable {
  case object
  case `enum`
  case interface
  case union
  case inputObject
  case customScalar
  case fragment(CompilationResult.FragmentDefinition)
  case operation(CompilationResult.OperationDefinition)
  case schema
  case testMock

  private var subpath: String {
    switch self {
    case .object: return "Objects"
    case .enum: return "Enums"
    case .interface: return "Interfaces"
    case .union: return "Unions"
    case .inputObject: return "InputObjects"
    case .customScalar: return "CustomScalars"

    case let .operation(operation) where operation.isLocalCacheMutation:
      return "LocalCacheMutations"
    case let .fragment(fragment) where fragment.isLocalCacheMutation:
      return "LocalCacheMutations"

    case .fragment: return "Fragments"
    case let .operation(operation):
      switch operation.operationType {
      case .query: return "Queries"
      case .mutation: return "Mutations"
      case .subscription: return "Subscriptions"
      }

    case .schema, .testMock: return ""
    }
  }

  func resolvePath(
    forConfig config: ApolloCodegen.ConfigurationContext
  ) -> String {
    switch self {
    case .object, .enum, .interface, .union, .inputObject, .customScalar, .schema:
      return resolveSchemaPath(forConfig: config)

    case let .fragment(fragmentDefinition):
      return resolveFragmentPath(
        forConfig: config,
        fragment: fragmentDefinition
      )

    case let .operation(operationDefinition):
      return resolveOperationPath(
        forConfig: config,
        operation: operationDefinition
      )

    case .testMock:
      return resolveTestMockPath(forConfig: config)
    }
  }

  private func resolveSchemaPath(
    forConfig config: ApolloCodegen.ConfigurationContext
  ) -> String {
    var moduleSubpath: String = "/"
    if case .swiftPackage = config.output.schemaTypes.moduleType {
      moduleSubpath += "Sources/"
    }
    if config.output.operations.isInModule {
      moduleSubpath += "Schema/"
    }

    let base = URL(fileURLWithPath: config.output.schemaTypes.path, relativeTo: config.rootURL)

    return base
      .appendingPathComponent("\(moduleSubpath)\(subpath)").standardizedFileURL.path
  }

  private func resolveFragmentPath(
    forConfig config: ApolloCodegen.ConfigurationContext,
    fragment: CompilationResult.FragmentDefinition
  ) -> String {
    switch config.output.operations {
    case .inSchemaModule:
      var url = URL(fileURLWithPath: config.output.schemaTypes.path, relativeTo: config.rootURL)
      if case .swiftPackage = config.output.schemaTypes.moduleType {
        url = url.appendingPathComponent("Sources")
      }

      return url.appendingPathComponent(subpath).path

    case let .absolute(path, _):
      return URL(fileURLWithPath: path, relativeTo: config.rootURL)
        .appendingPathComponent(subpath).path

    case let .relative(subpath, _):
      return resolveRelativePath(
        sourceURL: URL(fileURLWithPath: fragment.filePath),
        withSubpath: subpath
      )
    }
  }

  private func resolveRelativePath(sourceURL: URL, withSubpath subpath: String?) -> String {
    let relativeURL = sourceURL.deletingLastPathComponent()

    if let subpath = subpath {
      return relativeURL.appendingPathComponent(subpath).path
    }

    return relativeURL.path
  }

  private func resolveOperationPath(
    forConfig config: ApolloCodegen.ConfigurationContext,
    operation: CompilationResult.OperationDefinition
  ) -> String {
    switch config.output.operations {
    case .inSchemaModule:
      var url = URL(fileURLWithPath: config.output.schemaTypes.path, relativeTo: config.rootURL)
      if case .swiftPackage = config.output.schemaTypes.moduleType {
        url = url.appendingPathComponent("Sources")
      }
      if !operation.isLocalCacheMutation {
        url = url.appendingPathComponent("Operations")
      }

      return url
        .appendingPathComponent(subpath)
        .path

    case let .absolute(path, _):
      return URL(fileURLWithPath: path, relativeTo: config.rootURL)
        .appendingPathComponent(subpath).path

    case let .relative(subpath, _):
      return resolveRelativePath(
        sourceURL: URL(fileURLWithPath: operation.filePath),
        withSubpath: subpath
      )
    }
  }

  private func resolveTestMockPath(
    forConfig config: ApolloCodegen.ConfigurationContext
  ) -> String {
    switch config.output.testMocks {
    case .none:
      return ""
    case let .swiftPackage(targetName):
      return URL(fileURLWithPath: config.output.schemaTypes.path, relativeTo: config.rootURL)
        .appendingPathComponent(targetName ?? "TestMocks").path
    case let .absolute(path, _):
      return URL(fileURLWithPath: path, relativeTo: config.rootURL).path
    }
  }
}
