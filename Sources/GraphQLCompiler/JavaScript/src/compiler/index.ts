import {
  containsLocalCacheMutationDirective,
  getFieldDef,
  isMetaFieldName,
  isNotNullOrUndefined,
  transformToNetworkRequestSourceDefinition,
} from "../utilities";
import {
  ArgumentNode,
  ASTNode,
  DocumentNode,
  DirectiveNode,
  FragmentDefinitionNode,
  getNamedType,
  GraphQLArgument,
  GraphQLCompositeType,
  GraphQLDirective,
  GraphQLError,
  GraphQLField,
  GraphQLInputObjectType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLType,
  isCompositeType,
  isInputObjectType,
  isUnionType,
  Kind,
  OperationDefinitionNode,
  print,
  SelectionNode,
  SelectionSetNode,
  typeFromAST,
  isObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  FieldNode,
} from "graphql";
import * as ir from "./ir";
import { valueFromValueNode } from "./values";
import { ValidationOptions } from "../validationRules";
import { directive_typePolicy } from "../utilities/apolloCodegenSchemaExtension";

function filePathForNode(node: ASTNode): string | undefined {
  return node.loc?.source?.name;
}

export interface CompilationResult {
  rootTypes: ir.RootTypeDefinition;
  operations: ir.OperationDefinition[];
  fragments: ir.FragmentDefinition[];
  referencedTypes: GraphQLNamedType[];
  schemaDocumentation: string | undefined;
}

export function compileToIR(
  schema: GraphQLSchema,
  document: DocumentNode,
  legacySafelistingCompatibleOperations: boolean,
  reduceGeneratedSchemaTypes: boolean,
  validationOptions: ValidationOptions
): CompilationResult {
  // Collect fragment definition nodes upfront so we can compile these as we encounter them.
  const fragmentNodeMap = new Map<String, FragmentDefinitionNode>();

  for (const definitionNode of document.definitions) {
    if (definitionNode.kind !== Kind.FRAGMENT_DEFINITION) continue;

    fragmentNodeMap.set(definitionNode.name.value, definitionNode);
  }

  const operations: ir.OperationDefinition[] = [];
  const fragmentMap = new Map<String, ir.FragmentDefinition>();
  const referencedTypes = new Set<GraphQLNamedType>();
  const reduceSchemaTypes: boolean = reduceGeneratedSchemaTypes

  const queryType = schema.getQueryType() as GraphQLNamedType;
  if (queryType === undefined) {
    throw new GraphQLError("GraphQL Schema must contain a 'query' root type definition.", { });
  }

  const rootTypes: ir.RootTypeDefinition = {
    queryType: queryType,
    mutationType: schema.getMutationType() ?? undefined,
    subscriptionType: schema.getSubscriptionType() ?? undefined
  };

  for (const definitionNode of document.definitions) {
    if (definitionNode.kind !== Kind.OPERATION_DEFINITION) continue;

    operations.push(compileOperation(definitionNode));
  }

  // We should have encountered all fragments because GraphQL validation normally makes sure
  // there are no unused fragments in the document. But to allow for situations where you want that
  // validation rule removed, we compile the remaining ones separately.

  for (const [name, fragmentNode] of fragmentNodeMap.entries()) {
    fragmentMap.set(name, compileFragment(fragmentNode));
  }

  return {
    rootTypes: rootTypes,
    operations: operations,
    fragments: Array.from(fragmentMap.values()),
    referencedTypes: Array.from(referencedTypes.values()),
    schemaDocumentation: schema.description ?? undefined
  };

  function addReferencedType(type: GraphQLNamedType) {
    if (referencedTypes.has(type)) { return }

    referencedTypes.add(type)
    
    if (isInterfaceType(type)) {
      const possibleTypes = schema.getPossibleTypes(type);

      (type as any)._implementingObjects = possibleTypes;

      for (const objectType of possibleTypes) {
        if (!reduceSchemaTypes || hasTypePolicyDirective(objectType)) {
          addReferencedType(getNamedType(objectType))
        }
      }
    }

    if (isUnionType(type)) {
      const unionReferencedTypes = type.getTypes()
      for (type of unionReferencedTypes) {
        addReferencedType(getNamedType(type))
      }
    }

    if (isInputObjectType(type)) {
      addReferencedTypesFromInputObject(type)
    }

    if (isObjectType(type)) {
      for (const interfaceType of type.getInterfaces()) {
        addReferencedType(getNamedType(interfaceType))
      }
    }
  }

  function addReferencedTypesFromInputObject(
    inputObject: GraphQLInputObjectType
  ) {
    const fieldMap = inputObject.getFields()
    for (const key in fieldMap) {
      const field = fieldMap[key]
      addReferencedType(getNamedType(field.type))
    }
  }

  function hasTypePolicyDirective(
    type: GraphQLCompositeType
  ): boolean {
    const directiveName = directive_typePolicy.name.value;
    for (const directive of type.astNode?.directives ?? []) {
      if (directive.name.value === directiveName) {
        return true;
      }
    }
    return false;
  }

  function getFragment(name: string): ir.FragmentDefinition | undefined {
    let fragment = fragmentMap.get(name);
    if (fragment) return fragment;

    const fragmentNode = fragmentNodeMap.get(name);
    if (!fragmentNode) return undefined;

    // Remove the fragment node from the map so we know which ones we haven't encountered yet.
    fragmentNodeMap.delete(name);

    fragment = compileFragment(fragmentNode);
    fragmentMap.set(name, fragment);
    return fragment;
  }

  function compileOperation(
    operationDefinition: OperationDefinitionNode
  ): ir.OperationDefinition {
    if (!operationDefinition.name) {
      throw new GraphQLError("Operations should be named", { nodes: operationDefinition });
    }

    const filePath = filePathForNode(operationDefinition);
    const name = operationDefinition.name.value;
    const operationType = operationDefinition.operation;
    const referencedFragments = new Set<ir.FragmentDefinition>();

    const variables = (operationDefinition.variableDefinitions || []).map(
      (node) => {
        const name = node.variable.name.value;
        const defaultValue = node.defaultValue ? valueFromValueNode(node.defaultValue) : undefined

        // The casts are a workaround for the lack of support for passing a type union
        // to overloaded functions in TypeScript.
        // See https://github.com/microsoft/TypeScript/issues/14107
        const type = typeFromAST(schema, node.type as any) as GraphQLType;

        // `typeFromAST` returns `undefined` when a named type is not found
        // in the schema.
        if (!type) {
          throw new GraphQLError(
            `Couldn't get type from type node "${node.type}"`,
            { nodes: node }
          );
        }

        addReferencedType(getNamedType(type));

        return {
          name,
          type,
          defaultValue
        };
      }
    );

    const source = print(transformToNetworkRequestSourceDefinition(
      operationDefinition,
      legacySafelistingCompatibleOperations
    ));
    const rootType = schema.getRootType(operationType) as GraphQLObjectType;
    const [directives,] = compileDirectives(operationDefinition.directives) ?? [undefined, undefined];

    addReferencedType(rootType)

    const selectionSet = compileSelectionSet(operationDefinition.selectionSet, rootType, referencedFragments)
    const referencedFragmentsArray = Array.from(referencedFragments.values())

    if (containsLocalCacheMutationDirective(operationDefinition.directives)) {
      overrideAsLocalCacheMutation(referencedFragmentsArray);
    }

    return {
      name,
      operationType,
      variables,
      rootType,
      selectionSet: selectionSet,
      directives: directives,
      referencedFragments: referencedFragmentsArray,
      source,
      filePath
    };
  }

  function compileFragment(
    fragmentDefinition: FragmentDefinitionNode
  ): ir.FragmentDefinition {
    const name = fragmentDefinition.name.value;

    const filePath = filePathForNode(fragmentDefinition);
    const source = print(transformToNetworkRequestSourceDefinition(
      fragmentDefinition,
      legacySafelistingCompatibleOperations
    ));
    const referencedFragments = new Set<ir.FragmentDefinition>();

    const typeCondition = typeFromAST(
      schema,
      fragmentDefinition.typeCondition
    ) as GraphQLCompositeType;

    const [directives,] = compileDirectives(fragmentDefinition.directives) ?? [undefined, undefined];

    addReferencedType(getNamedType(typeCondition));

    const selectionSet = compileSelectionSet(fragmentDefinition.selectionSet, typeCondition, referencedFragments)
    const referencedFragmentsArray = Array.from(referencedFragments.values())

    if (containsLocalCacheMutationDirective(fragmentDefinition.directives)) {
      overrideAsLocalCacheMutation(referencedFragmentsArray);
    }

    return {
      name,
      filePath,
      source,
      typeCondition,
      selectionSet: selectionSet,
      directives: directives,
      referencedFragments: referencedFragmentsArray,
      overrideAsLocalCacheMutation: false
    };
  }

  function overrideAsLocalCacheMutation(
    fragments: ir.FragmentDefinition[]
  ) {
    fragments.forEach(element => {
      element.overrideAsLocalCacheMutation = true
      overrideAsLocalCacheMutation(element.referencedFragments)
    });
  }

  function compileSelectionSet(
    selectionSetNode: SelectionSetNode,
    parentType: GraphQLCompositeType,
    operationReferencedFragments: Set<ir.FragmentDefinition>,
  ): ir.SelectionSet {
    return {
      parentType,
      selections: selectionSetNode.selections
        .map((selectionNode) =>
          compileSelection(selectionNode, parentType, operationReferencedFragments)
        )
        .filter(isNotNullOrUndefined),
    };
  }

  function compileSelection(
    selectionNode: SelectionNode,
    parentType: GraphQLCompositeType,
    operationReferencedFragments: Set<ir.FragmentDefinition>,
  ): ir.Selection | undefined {
    const [directives, inclusionConditions] = compileDirectives(selectionNode.directives) ?? [undefined, undefined];

    switch (selectionNode.kind) {
      case Kind.FIELD: {
        const name = selectionNode.name.value;
        if (name == "__typename") { return undefined }
        const alias = selectionNode.alias?.value;

        const fieldDef = getFieldDef(schema, parentType, name);
        if (!fieldDef) {
          throw new GraphQLError(
            `Cannot query field "${name}" on type "${String(parentType)}"`,
            { nodes: selectionNode }
          );
        }

        const fieldType = fieldDef.type;
        const unwrappedFieldType = getNamedType(fieldDef.type);

        addReferencedType(getNamedType(unwrappedFieldType));

        const { description, deprecationReason } = fieldDef;
        const args: ir.Field["arguments"] = compileArguments(fieldDef, selectionNode.arguments);

        let field: ir.Field = {
          kind: "Field",
          name,
          alias,
          type: fieldType,
          arguments: args,
          inclusionConditions: inclusionConditions,
          description: !isMetaFieldName(name) && description ? description : undefined,
          deprecationReason: deprecationReason || undefined,
          directives: directives,
        };

        function validateFieldName(node: FieldNode, disallowedNames?: Array<string>, schemaNamespace?: string) {
          if (disallowedNames && schemaNamespace) {
            const responseKey = (node.alias ?? node.name).value
            const responseKeyFirstLowercase = responseKey.charAt(0).toLowerCase() + responseKey.slice(1)

            if (disallowedNames?.includes(responseKeyFirstLowercase)) {
              throw new GraphQLError(
                `Schema name "${schemaNamespace}" conflicts with name of a generated object API. Please choose a different schema name. Suggestions: "${schemaNamespace}Schema", "${schemaNamespace}GraphQL", "${schemaNamespace}API"`,
                { nodes: node }
              );
            }
          }
        }

        if (isListType(fieldType) || (isNonNullType(fieldType) && isListType(fieldType.ofType))) {
          validateFieldName(selectionNode, validationOptions.disallowedFieldNames?.entityList, validationOptions.schemaNamespace)
        } else if (isCompositeType(unwrappedFieldType)) {
          validateFieldName(selectionNode, validationOptions.disallowedFieldNames?.entity, validationOptions.schemaNamespace)
        }

        if (isCompositeType(unwrappedFieldType)) {
          const selectionSetNode = selectionNode.selectionSet;

          if (!selectionSetNode) {
            throw new GraphQLError(
              `Composite field "${name}" on type "${String(
                parentType
              )}" requires selection set`,
              { nodes: selectionNode }
            );
          }

          field.selectionSet = compileSelectionSet(
            selectionSetNode,
            unwrappedFieldType,
            operationReferencedFragments
          );
        }
        return field;
      }
      case Kind.INLINE_FRAGMENT: {
        const typeNode = selectionNode.typeCondition;
        const typeCondition = typeNode
          ? (typeFromAST(schema, typeNode) as GraphQLCompositeType)
          : parentType;

        addReferencedType(typeCondition);

        return {
          kind: "InlineFragment",
          selectionSet: compileSelectionSet(
            selectionNode.selectionSet,
            typeCondition,
            operationReferencedFragments
          ),
          inclusionConditions: inclusionConditions,
          directives: directives
        };
      }
      case Kind.FRAGMENT_SPREAD: {
        const fragmentName = selectionNode.name.value;

        const fragment = getFragment(fragmentName);
        if (!fragment) {
          throw new GraphQLError(
            `Unknown fragment "${fragmentName}".`,
            { nodes: selectionNode.name }
          );
        }

        operationReferencedFragments.add(fragment);

        const fragmentSpread: ir.FragmentSpread = {
          kind: "FragmentSpread",
          fragment,
          inclusionConditions: inclusionConditions,
          directives: directives
        };
        return fragmentSpread;
      }
    }
  }

  function compileArguments(
    ...args:
    [fieldDef: GraphQLField<any, any, any>, args?: ReadonlyArray<ArgumentNode>] |
    [directiveDef: GraphQLDirective, args?: ReadonlyArray<ArgumentNode>]
  ): ir.Argument[] | undefined {
    const argDefs: ReadonlyArray<GraphQLArgument> = args[0].args
    return args[1] && args[1].length > 0
      ? args[1].map((arg) => {
        const name = arg.name.value;
        const argDef = argDefs.find(
          (argDef) => argDef.name === arg.name.value
        );
        const argDefType = argDef?.type;

        if (!argDefType) {
          throw new GraphQLError(
            `Cannot find directive argument type for argument "${name}".`,
            { nodes: [arg] }
          );
        }

        return {
          name,
          value: valueFromValueNode(arg.value),
          type: argDefType,
          deprecationReason: argDef.deprecationReason ?? undefined
        };
      })
      : undefined;
  }

  function compileDirectives(
    directives?: ReadonlyArray<DirectiveNode>
  ): [ir.Directive[], ir.InclusionCondition[]?] | undefined {
    if (directives && directives.length > 0) {
      const compiledDirectives: ir.Directive[] = [];
      const inclusionConditions: ir.InclusionCondition[] = [];

      for (const directive of directives) {
        const name = directive.name.value;
        const directiveDef = schema.getDirective(name)

        if (!directiveDef) {
          throw new GraphQLError(
            `Cannot find directive "${name}".`,
            { nodes: directive }
          );
        }

        compiledDirectives.push(
          {
            name: name,
            arguments: compileArguments(directiveDef, directive.arguments)
          }
        );

        const condition = compileInclusionCondition(directive, directiveDef);
        if (condition) { inclusionConditions.push(condition) };
      }

      return [
        compiledDirectives,
        inclusionConditions.length > 0 ? inclusionConditions : undefined
      ]

    } else {
      return undefined;
    }
  }

  function compileInclusionCondition(
    directiveNode: DirectiveNode,
    directiveDef: GraphQLDirective
  ): ir.InclusionCondition | undefined {
    if (directiveDef.name == "include" || directiveDef.name == "skip") {
      const condition = directiveNode.arguments?.[0].value;
      const isInverted = directiveDef.name == "skip";

      switch (condition?.kind) {
        case Kind.BOOLEAN:
          if (isInverted) {
            return condition.value ? "SKIPPED" : "INCLUDED";
          } else {
            return condition.value ? "INCLUDED" : "SKIPPED";
          }

        case Kind.VARIABLE:
          return {
            variable: condition.name.value,
            isInverted: isInverted
          }

        default:
          throw new GraphQLError(
            `Conditional inclusion directive has invalid "if" argument.`,
            { nodes: directiveNode }
          );
          break;
      }
    } else {
      return undefined
    }
  }

}
