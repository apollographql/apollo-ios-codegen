import {
  ASTNode,
  FieldNode,
  GraphQLCompositeType,
  GraphQLField,
  GraphQLSchema,
  isInterfaceType,
  isObjectType,
  isUnionType,
  Kind,
  Location,
  SchemaMetaFieldDef,
  SelectionSetNode,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
  validateSchema,
  visit,
  GraphQLError,
  DocumentNode,
  DirectiveNode,
  DirectiveDefinitionNode
} from "graphql";
import { isNode } from "graphql/language/ast";
import { validateSDL } from "graphql/validation/validate";
import { directive_apollo_client_ios_localCacheMutation, directive_import_statement } from "./apolloCodegenSchemaExtension";
import { addTypeNameFieldForLegacySafelisting } from "./legacySafelistingTransform";

export class GraphQLSchemaValidationError extends Error {
  constructor(public validationErrors: readonly GraphQLError[]) {
    super(validationErrors.map((error) => error.message).join("\n\n"));

    this.name = "GraphQLSchemaValidationError";
  }
}

export function assertValidSDL(document: DocumentNode) {
  const errors = validateSDL(document);
  if (errors.length !== 0) {
    throw new GraphQLSchemaValidationError(errors);
  }
}

export function assertValidSchema(schema: GraphQLSchema) {
  const errors = validateSchema(schema);
  if (errors.length !== 0) {
    throw new GraphQLSchemaValidationError(errors);
  }
}

export function sourceAt(location: Location) {
  return location.source.body.slice(location.start, location.end);
}

export function filePathForNode(node: ASTNode): string | undefined {
  return node.loc?.source?.name;
}

export function isMetaFieldName(name: string) {
  return name.startsWith("__");
}

export function containsLocalCacheMutationDirective(directives: readonly DirectiveNode[] | undefined): boolean {
  if (!directives) return false

  for (const directive of directives) {
    if (directive.name.value == directive_apollo_client_ios_localCacheMutation.name.value) {
      return true
    }
  }

  return false
}

const typenameField: FieldNode = {
  kind: Kind.FIELD,
  name: { kind: Kind.NAME, value: "__typename" },
};

export function transformToNetworkRequestSourceDefinition(
  ast: ASTNode,
  legacySafelistingCompatibleOperations: boolean
) {
  if (legacySafelistingCompatibleOperations) {
    ast = addTypeNameFieldForLegacySafelisting(ast)
  }

  return visit(ast, {
    SelectionSet: {
      leave(node: SelectionSetNode, _, parent) {
        if (isNode(parent) && ![Kind.FIELD, Kind.FRAGMENT_DEFINITION].includes(parent.kind)) {
          return node
        }
        return addTypenameFieldToSelectionSetIfNeeded(node)
      }
    },
    Field: {
      enter(node: FieldNode) {
        return transformTypenameFieldIfNeeded(node)
      }
    },
    Directive: {
      enter(node: DirectiveNode) {
        return stripApolloClientSpecificDirectives(node)
      }
    }
  });
}

function addTypenameFieldToSelectionSetIfNeeded(node: SelectionSetNode): SelectionSetNode {
  const hasTypenameField = node.selections.find((selection) =>
    selection.kind == typenameField.kind && selection.name.value == typenameField.name.value
  );

  if (hasTypenameField) {
    return node
  } else {
    return {
      ...node,
      selections: [typenameField, ...node.selections],
    };
  }
}

function transformTypenameFieldIfNeeded(node: FieldNode): FieldNode {
  if (node.name.value == typenameField.name.value) {
    return {
      ...node,
      alias: undefined,
      directives: undefined
    }
  } else {
    return node;
  }
}

function stripApolloClientSpecificDirectives(node: DirectiveNode): DirectiveNode | null {
  const apolloClientSpecificDirectives: DirectiveDefinitionNode[] = [
    directive_apollo_client_ios_localCacheMutation,
    directive_import_statement
  ]

  for (const directive of apolloClientSpecificDirectives) {
    if (node.name.value == directive.name.value) {
      return null
    }
  }

  return node
}

// Utility functions extracted from graphql-js

/**
 * Not exactly the same as the executor's definition of getFieldDef, in this
 * statically evaluated environment we do not always have an Object type,
 * and need to handle Interface and Union types.
 */
export function getFieldDef(
  schema: GraphQLSchema,
  parentType: GraphQLCompositeType,
  fieldName: string,
): GraphQLField<any, any> | undefined {
  if (
    fieldName === SchemaMetaFieldDef.name &&
    schema.getQueryType() === parentType
  ) {
    return SchemaMetaFieldDef;
  }
  if (fieldName === TypeMetaFieldDef.name && schema.getQueryType() === parentType) {
    return TypeMetaFieldDef;
  }
  if (
    fieldName === TypeNameMetaFieldDef.name &&
    (isObjectType(parentType) ||
      isInterfaceType(parentType) ||
      isUnionType(parentType))
  ) {
    return TypeNameMetaFieldDef;
  }
  if (isObjectType(parentType) || isInterfaceType(parentType)) {
    return parentType.getFields()[fieldName];
  }

  return undefined;
}
