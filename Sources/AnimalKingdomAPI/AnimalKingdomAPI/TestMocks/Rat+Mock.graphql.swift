// @generated
// This file was automatically generated and should not be edited.

import ApolloTestSupport
import AnimalKingdomAPI

public class Rat: MockObject {
  public static let objectType: Object = AnimalKingdomAPI.Objects.Rat
  public static let _mockFields = MockFields()
  public typealias MockValueCollectionType = Array<Mock<Rat>>

  public struct MockFields {
    @Field<String>("favoriteToy") public var favoriteToy
    @Field<Height>("height") public var height
    @Field<String>("humanName") public var humanName
    @Field<AnimalKingdomAPI.ID>("id") public var id
    @Field<Human>("owner") public var owner
    @Field<[Animal]>("predators") public var predators
    @Field<GraphQLEnum<AnimalKingdomAPI.SkinCovering>>("skinCovering") public var skinCovering
    @Field<String>("species") public var species
  }
}

public extension Mock where O == Rat {
  convenience init(
    favoriteToy: String? = nil,
    height: Mock<Height>? = nil,
    humanName: String? = nil,
    id: AnimalKingdomAPI.ID? = nil,
    owner: Mock<Human>? = nil,
    predators: [AnyMock]? = nil,
    skinCovering: GraphQLEnum<AnimalKingdomAPI.SkinCovering>? = nil,
    species: String? = nil
  ) {
    self.init()
    _set(favoriteToy, for: \.favoriteToy)
    _set(height, for: \.height)
    _set(humanName, for: \.humanName)
    _set(id, for: \.id)
    _set(owner, for: \.owner)
    _set(predators, for: \.predators)
    _set(skinCovering, for: \.skinCovering)
    _set(species, for: \.species)
  }
}